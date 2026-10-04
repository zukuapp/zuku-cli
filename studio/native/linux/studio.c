#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <gio/gio.h>
#include <sys/stat.h>
#include <unistd.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <errno.h>
#include "protocol.h"

#ifndef STUDIO_NODE
#error Managed absolute Node path is required.
#endif
const char *studio_runtime_node;
const char *studio_runtime_fixture;
const char *studio_runtime_schema;
static char *installation_root, *host_entry, *bridge_file, *installation_node;
static WebKitWebContext *prepared_context;

typedef struct { char *bytes; gsize length; gboolean sensitive; } Outgoing;
typedef struct { char *method, *reply_id; gint64 expires; gint rect[4]; guint preview_generation; } Pending;
typedef struct {
  GtkApplication *application;
  GtkWidget *window, *status, *preview_layer;
  GtkFileChooserNative *chooser;
  WebKitWebView *view, *preview;
  WebKitUserContentManager *manager;
  WebKitUserContentFilterStore *filter_store;
  char *filter_directory;
  JSCContext *json;
  GSubprocess *host;
  GCancellable *cancel;
  GByteArray *incoming;
  GQueue queue, render_queue;
  GHashTable *pending;
  gsize queue_bytes, render_bytes;
  gboolean writing, rendering, read_inflight, ready, stopping, host_dead, held;
  char *page_uri, *preview_origin, *preview_base, *chooser_id;
  char *dialog_request, *auth_kind, *auth_url;
  GtkWidget *dialog, *secret_entry;
  gboolean secret_dialog;
  guint dialog_timeout, pending_timer, preview_generation;
} Studio;

static Studio app;
typedef struct { Studio *state; char *uri, *reply; guint generation; gint rect[4]; } PreviewLoad;
static void begin_write(Studio *state);
static gboolean send_rpc(Studio *state, const char *id, const char *method, JSCValue *params, gboolean sensitive);
static void shutdown_host(Studio *state);
static void consume_host(Studio *state);
static void render_next(Studio *state);
static void hide_preview(Studio *state);
static gboolean initialize_gui(void) {
  if (!gtk_init_check(NULL, NULL)) return FALSE;
  /* WebKit must initialize its main run loop before standalone JavaScriptCore.
   * Reversing that order stalls all WebView loads on WebKitGTK 2.50.4. */
  WebKitWebsiteDataManager *data = webkit_website_data_manager_new_ephemeral();
  prepared_context = webkit_web_context_new_with_website_data_manager(data); g_object_unref(data);
  webkit_web_context_set_sandbox_enabled(prepared_context, TRUE);
  return webkit_web_context_get_sandbox_enabled(prepared_context);
}

static const char *assets[] = {
  "studio/renderer/index.html", "studio/renderer/main.mjs", "studio/renderer/index.mjs",
  "studio/renderer/app.mjs", "studio/renderer/client.mjs", "studio/renderer/state.mjs",
  "studio/renderer/dom.mjs", "studio/renderer/diff.mjs", "studio/renderer/preview.mjs",
  "studio/renderer/styles.css", "lib/agent-protocol/schema.mjs", "studio/native/bridge.js", NULL
};

static gboolean trusted_file(const char *path, gboolean executable) {
  if (!path || !g_path_is_absolute(path)) return FALSE;
  char *resolved = realpath(path, NULL); if (!resolved || strcmp(path, resolved)) { free(resolved); return FALSE; } free(resolved);
  struct stat info; if (lstat(path, &info) || !S_ISREG(info.st_mode) || info.st_nlink != 1 || (info.st_mode & 0022) || (info.st_uid != geteuid() && info.st_uid != 0) || (executable && access(path, X_OK))) return FALSE;
  char *directory = g_path_get_dirname(path); gboolean valid = TRUE;
  while (strcmp(directory, "/")) {
    if (lstat(directory, &info) || !S_ISDIR(info.st_mode) || (info.st_mode & 0022) || (info.st_uid != geteuid() && info.st_uid != 0)) { valid = FALSE; break; }
    char *parent = g_path_get_dirname(directory); g_free(directory); directory = parent;
  }
  g_free(directory); return valid;
}
static gboolean trusted_ui(void) {
  for (gsize i = 0; assets[i]; i++) { char *path = g_build_filename(installation_root, assets[i], NULL); gboolean valid = trusted_file(path, FALSE); g_free(path); if (!valid) return FALSE; }
  return TRUE;
}
static gboolean locate_release(const char *directory) {
  char *canonical = g_build_filename(directory, "npm", "lib", "node_modules", "@zuku", "cli", NULL);
  struct stat package_info; int exists = lstat(canonical, &package_info);
  if (exists && errno != ENOENT) { g_free(canonical); return FALSE; }
  const char *scope = exists ? "@zukujs" : "@zuku", *package_name = exists ? "@zukujs/cli" : "@zuku/cli";
  g_free(canonical);
  char *marker = g_build_filename(directory, "install.json", NULL), *package_path = g_build_filename(directory, "npm", "lib", "node_modules", scope, "cli", "package.json", NULL);
  char *marker_text = NULL, *package_text = NULL; gsize marker_length = 0, package_length = 0; gboolean valid = FALSE;
  if (trusted_file(marker, FALSE) && trusted_file(package_path, FALSE) && g_file_get_contents(marker, &marker_text, &marker_length, NULL) && marker_length <= 4096 && g_file_get_contents(package_path, &package_text, &package_length, NULL) && package_length <= 65536) {
    JSCContext *json = jsc_context_new(); JSCValue *record = studio_parse(json, marker_text, marker_length), *package = studio_parse(json, package_text, package_length);
    char *schema = record ? studio_string(record, "schema") : NULL, *version = record ? studio_string(record, "version") : NULL, *sha = record ? studio_string(record, "sha256") : NULL, *node = record ? studio_string(record, "node") : NULL;
    char *name = package ? studio_string(package, "name") : NULL, *package_version = package ? studio_string(package, "version") : NULL;
    char *expected_node = g_build_filename(directory, "runtime", "bin", "node", NULL);
    valid = !g_strcmp0(schema, "zukujs-user-install/1") && !g_strcmp0(name, package_name) && version && !g_strcmp0(version, package_version) && sha && g_regex_match_simple("^[a-f0-9]{64}$", sha, 0, 0) && node && !g_strcmp0(node, expected_node) && trusted_file(expected_node, TRUE);
    if (valid) { installation_root = g_path_get_dirname(package_path); installation_node = g_strdup(node); }
    g_free(expected_node);
    g_free(schema); g_free(version); g_free(sha); g_free(node); g_free(name); g_free(package_version); g_clear_object(&record); g_clear_object(&package); g_object_unref(json);
  }
  g_free(marker_text); g_free(package_text); g_free(marker); g_free(package_path); return valid;
}
static gboolean locate_installation(const char *node_option) {
  char executable[4097]; ssize_t n = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
  if (n <= 0 || n >= (ssize_t)sizeof(executable) - 1) return FALSE;
  executable[n] = 0;
  char *directory = g_path_get_dirname(executable);
  for (guint i = 0; i < 10 && strcmp(directory, "/"); i++) {
    char *release_marker = g_build_filename(directory, "install.json", NULL);
    gboolean has_release_marker = g_file_test(release_marker, G_FILE_TEST_EXISTS) || g_file_test(release_marker, G_FILE_TEST_IS_SYMLINK); g_free(release_marker);
    if (has_release_marker) { if (!locate_release(directory)) { g_free(directory); return FALSE; } break; }
    char *marker = g_build_filename(directory, "package.json", NULL);
    if (trusted_file(marker, FALSE)) {
      char *text = NULL; gsize length = 0;
      if (g_file_get_contents(marker, &text, &length, NULL) && length <= 65536) {
        JSCContext *json = jsc_context_new(); JSCValue *package = studio_parse(json, text, length);
        char *name = package ? studio_string(package, "name") : NULL;
        if (!g_strcmp0(name, "@zuku/cli") || !g_strcmp0(name, "@zukujs/cli")) installation_root = g_strdup(directory);
        g_free(name); g_clear_object(&package); g_object_unref(json);
      }
      g_free(text);
    }
    g_free(marker); if (installation_root) break;
    char *parent = g_path_get_dirname(directory); g_free(directory); directory = parent;
  }
  g_free(directory); if (!installation_root) return FALSE;
  host_entry = g_build_filename(installation_root, "lib", "studio-host.mjs", NULL);
  bridge_file = g_build_filename(installation_root, "studio", "native", "bridge.js", NULL);
  studio_runtime_fixture = g_build_filename(installation_root, "studio", "native", "linux", "tests", "stdio-fixture.mjs", NULL);
  studio_runtime_schema = g_build_filename(installation_root, "lib", "agent-protocol", "schema.mjs", NULL);
  if (installation_node && node_option && strcmp(node_option, installation_node)) return FALSE;
  const char *node = installation_node ? installation_node : node_option ? node_option : STUDIO_NODE;
  char *resolved = node && g_path_is_absolute(node) ? realpath(node, NULL) : NULL;
  if (!resolved || !trusted_file(resolved, TRUE) || !trusted_file(studio_runtime_schema, FALSE)) { free(resolved); return FALSE; }
  studio_runtime_node = g_strdup(resolved); free(resolved); return TRUE;
}
static void outgoing_free(Outgoing *message) {
  if (message->sensitive) { volatile char *cursor = message->bytes; for (gsize i = 0; i < message->length; i++) cursor[i] = 0; }
  g_free(message->bytes); g_free(message);
}
static void pending_free(gpointer data) { Pending *pending = data; g_free(pending->method); g_free(pending->reply_id); g_free(pending); }
static void set_string(JSCValue *object, const char *key, const char *value) { JSCValue *entry = jsc_value_new_string(jsc_value_get_context(object), value); jsc_value_object_set_property(object, key, entry); g_object_unref(entry); }
static void protocol(JSCValue *object) { JSCValue *version = jsc_value_new_number(jsc_value_get_context(object), 1); jsc_value_object_set_property(object, "protocolVersion", version); g_object_unref(version); }
static void evaluated(GObject *source, GAsyncResult *result, gpointer data) {
  Studio *state = data; GError *error = NULL; JSCValue *value = webkit_web_view_evaluate_javascript_finish(WEBKIT_WEB_VIEW(source), result, &error); g_clear_object(&value); g_clear_error(&error);
  char *script = g_queue_pop_head(&state->render_queue); state->render_bytes -= strlen(script); g_free(script); state->rendering = FALSE;
  if (!state->stopping) { render_next(state); consume_host(state); }
}
static void render_next(Studio *state) {
  if (state->rendering || state->stopping || g_queue_is_empty(&state->render_queue)) return;
  state->rendering = TRUE;
  webkit_web_view_evaluate_javascript(state->view, g_queue_peek_head(&state->render_queue), -1, NULL, state->page_uri, state->cancel, evaluated, state);
}
static void to_renderer(Studio *state, JSCValue *value) {
  if (!state->ready || state->stopping || g_strcmp0(webkit_web_view_get_uri(state->view), state->page_uri)) return;
  char *json = jsc_value_to_json(value, 0); if (!json || strlen(json) > STUDIO_RESPONSE_BYTES) { g_free(json); return; }
  /* JSON serializes every string; no host text is interpolated as JavaScript source. */
  char *script = g_strdup_printf("window.ZukuStudioReceive(%s)", json);
  g_free(json);
  if (g_queue_get_length(&state->render_queue) >= STUDIO_QUEUE_COUNT || state->render_bytes + strlen(script) > STUDIO_QUEUE_BYTES) { g_free(script); shutdown_host(state); return; }
  state->render_bytes += strlen(script); g_queue_push_tail(&state->render_queue, script); render_next(state);
}
static void renderer_error(Studio *state, const char *id, const char *code) {
  JSCValue *response = jsc_value_new_object(state->json, NULL, NULL), *error = jsc_value_new_object(state->json, NULL, NULL);
  protocol(response); set_string(response, "id", id); set_string(error, "code", code); set_string(error, "message", "작업을 완료하지 못했습니다. 연결 상태와 권한을 확인해 주세요.");
  jsc_value_object_set_property(response, "error", error); to_renderer(state, response); g_object_unref(error); g_object_unref(response);
}
static void log_line(Studio *state, const char *line) {
  if (state->status && line && g_utf8_validate(line, -1, NULL)) gtk_label_set_text(GTK_LABEL(state->status), line);
}
static void host_unavailable(Studio *state) {
  log_line(state, "코어 연결이 종료되었습니다. 앱을 다시 시작해 주세요.");
  GHashTableIter iterator; gpointer key, value; g_hash_table_iter_init(&iterator, state->pending);
  while (g_hash_table_iter_next(&iterator, &key, &value)) { Pending *pending = value; const char *reply = pending->reply_id ? pending->reply_id : key; if (!g_str_has_prefix(reply, "native_")) renderer_error(state, reply, "HOST_UNAVAILABLE"); g_hash_table_iter_remove(&iterator); }
}
static void written(GObject *source, GAsyncResult *result, gpointer data) {
  Studio *state = data; GError *error = NULL; gsize count = 0;
  gboolean ok = g_output_stream_write_all_finish(G_OUTPUT_STREAM(source), result, &count, &error);
  Outgoing *message = g_queue_pop_head(&state->queue); state->queue_bytes -= message->length; outgoing_free(message); state->writing = FALSE;
  if (!ok || error) { g_clear_error(&error); if (!state->stopping) host_unavailable(state); }
  else begin_write(state);
}
static void begin_write(Studio *state) {
  if (state->writing || state->stopping || g_queue_is_empty(&state->queue)) return;
  Outgoing *message = g_queue_peek_head(&state->queue); state->writing = TRUE;
  g_output_stream_write_all_async(g_subprocess_get_stdin_pipe(state->host), message->bytes, message->length, G_PRIORITY_DEFAULT, state->cancel, written, state);
}
static gboolean send_rpc(Studio *state, const char *id, const char *method, JSCValue *params, gboolean sensitive) {
  if (!state->host || state->host_dead || state->stopping || g_hash_table_size(state->pending) >= 128 || g_hash_table_contains(state->pending, id)) return FALSE;
  JSCValue *request = jsc_value_new_object(state->json, NULL, NULL); protocol(request); set_string(request, "id", id); set_string(request, "method", method); jsc_value_object_set_property(request, "params", params);
  char *json = jsc_value_to_json(request, 0); g_object_unref(request); if (!json) return FALSE;
  gsize length = strlen(json) + 1;
  if (length > STUDIO_LINE_BYTES || g_queue_get_length(&state->queue) >= STUDIO_QUEUE_COUNT || state->queue_bytes + length > STUDIO_QUEUE_BYTES) { if (sensitive) { volatile char *p = json; for (gsize i = 0; i < length - 1; i++) p[i] = 0; } g_free(json); return FALSE; }
  Outgoing *out = g_new0(Outgoing, 1); out->bytes = g_strconcat(json, "\n", NULL); out->length = length; out->sensitive = sensitive;
  if (sensitive) { volatile char *p = json; for (gsize i = 0; i < length - 1; i++) p[i] = 0; } g_free(json);
  Pending *pending = g_new0(Pending, 1); pending->method = g_strdup(method); pending->expires = g_get_monotonic_time() + 180 * G_USEC_PER_SEC;
  g_hash_table_insert(state->pending, g_strdup(id), pending); g_queue_push_tail(&state->queue, out); state->queue_bytes += length; begin_write(state); return TRUE;
}
static void native_rpc(Studio *state, const char *method, JSCValue *params, gboolean sensitive) {
  char *uuid = g_uuid_string_random(), *id = g_strconcat("native_", uuid, NULL); if (!send_rpc(state, id, method, params, sensitive)) log_line(state, "코어 요청 대기열이 가득 찼거나 연결이 종료되었습니다."); g_free(id); g_free(uuid);
}
static gboolean pending_expiry(gpointer data) {
  Studio *state = data; if (state->stopping) return G_SOURCE_REMOVE;
  GHashTableIter iterator; gpointer key, value; g_hash_table_iter_init(&iterator, state->pending);
  while (g_hash_table_iter_next(&iterator, &key, &value)) { Pending *pending = value; if (pending->expires <= g_get_monotonic_time()) { const char *reply = pending->reply_id ? pending->reply_id : key; if (!g_str_has_prefix(reply, "native_")) renderer_error(state, reply, "HOST_TIMEOUT"); g_hash_table_iter_remove(&iterator); } }
  return G_SOURCE_CONTINUE;
}
static void dialog_response(GtkDialog *dialog, gint response, gpointer data) {
  Studio *state = data; if (state->dialog_timeout) { g_source_remove(state->dialog_timeout); state->dialog_timeout = 0; }
  JSCValue *params = jsc_value_new_object(state->json, NULL, NULL); set_string(params, "requestId", state->dialog_request);
  if (state->secret_dialog) {
    const char *value;
    if (!g_strcmp0(state->auth_kind, "secret")) value = response == GTK_RESPONSE_ACCEPT ? gtk_entry_get_text(GTK_ENTRY(state->secret_entry)) : "";
    else if (!g_strcmp0(state->auth_kind, "decision")) value = response == GTK_RESPONSE_ACCEPT ? "allow" : "deny";
    else value = response == GTK_RESPONSE_ACCEPT ? "ack" : "deny";
    set_string(params, "value", value); native_rpc(state, "native.authResponse", params, TRUE); if (state->secret_entry) gtk_entry_set_text(GTK_ENTRY(state->secret_entry), "");
  } else { JSCValue *allow = jsc_value_new_boolean(state->json, response == GTK_RESPONSE_ACCEPT); jsc_value_object_set_property(params, "allow", allow); g_object_unref(allow); native_rpc(state, "native.pairingDecision", params, FALSE); }
  g_object_unref(params); g_clear_pointer(&state->dialog_request, g_free); g_clear_pointer(&state->auth_kind, g_free); g_clear_pointer(&state->auth_url, g_free); state->dialog = NULL; state->secret_entry = NULL; gtk_widget_destroy(GTK_WIDGET(dialog));
}
static gboolean dialog_expired(gpointer data) { Studio *state = data; state->dialog_timeout = 0; if (state->dialog) gtk_dialog_response(GTK_DIALOG(state->dialog), GTK_RESPONSE_CANCEL); return G_SOURCE_REMOVE; }
static void open_auth_url(GtkButton *button, gpointer data) {
  (void)button; Studio *state = data; if (!state->dialog || !state->auth_url) return;
  GError *error = NULL;
  if (!gtk_show_uri_on_window(GTK_WINDOW(state->dialog), state->auth_url, GDK_CURRENT_TIME, &error)) log_line(state, "기본 브라우저를 열지 못했습니다. 네이티브 인증 창의 공식 주소를 직접 확인해 주세요.");
  g_clear_error(&error);
}
static void native_prompt(Studio *state, JSCValue *data, gboolean secret) {
  char *request = studio_string(data, "requestId"), *origin = studio_string(data, "origin"), *question = studio_string(data, "question"), *kind = studio_string(data, "kind");
  JSCValue *expiry = jsc_value_object_get_property(data, "expiresAt"); double remaining = jsc_value_is_number(expiry) ? jsc_value_to_double(expiry) - (double)(g_get_real_time() / 1000) : 120000; g_object_unref(expiry);
  if (secret && !kind) kind = g_strdup("secret");
  gboolean valid_secret = secret && (!strcmp(kind, "secret") || !strcmp(kind, "decision") || !strcmp(kind, "device-authorization") || !strcmp(kind, "authorization-url"));
  gboolean valid = studio_identifier(request) && remaining > 0 && remaining <= 125000 && (secret ? valid_secret && question && strlen(question) <= 1000 : g_strcmp0(origin, "https://ai.zuzunza.com") == 0);
  if (!valid || state->dialog) {
    if (studio_identifier(request)) { JSCValue *reject = jsc_value_new_object(state->json, NULL, NULL); set_string(reject, "requestId", request); if (secret) set_string(reject, "value", ""); else { JSCValue *allow = jsc_value_new_boolean(state->json, FALSE); jsc_value_object_set_property(reject, "allow", allow); g_object_unref(allow); } native_rpc(state, secret ? "native.authResponse" : "native.pairingDecision", reject, secret); g_object_unref(reject); }
    g_free(request); g_free(origin); g_free(question); g_free(kind); return;
  }
  state->dialog_request = request; state->secret_dialog = secret; state->auth_kind = kind;
  state->dialog = gtk_dialog_new_with_buttons(secret ? "제공자 인증" : "ZUKU 웹 연결 승인", GTK_WINDOW(state->window), GTK_DIALOG_MODAL | GTK_DIALOG_DESTROY_WITH_PARENT, "거절", GTK_RESPONSE_CANCEL, secret ? "확인" : "연결 허용", GTK_RESPONSE_ACCEPT, NULL);
  gtk_dialog_set_default_response(GTK_DIALOG(state->dialog), GTK_RESPONSE_CANCEL);
  GtkWidget *box = gtk_dialog_get_content_area(GTK_DIALOG(state->dialog));
  char *project_name = studio_string(data, "projectName");
  char *notice = project_name && strlen(project_name) <= 480 ? g_strdup_printf("https://ai.zuzunza.com 웹 화면에서 '%s' 게임 작업을 이어가도록 허용하시겠습니까?", project_name) : g_strdup("https://ai.zuzunza.com 웹 화면을 이 컴퓨터의 ZUKU Studio와 연결하시겠습니까?\n선택한 게임 프로젝트와 등록된 제공자로 작업할 수 있습니다.");
  GtkWidget *label = gtk_label_new(secret ? question : notice); g_free(project_name); g_free(notice);
  gtk_label_set_line_wrap(GTK_LABEL(label), TRUE); gtk_widget_set_margin_start(label, 20); gtk_widget_set_margin_end(label, 20); gtk_widget_set_margin_top(label, 20); gtk_widget_set_margin_bottom(label, 20); gtk_container_add(GTK_CONTAINER(box), label);
  if (secret && !strcmp(kind, "secret")) { state->secret_entry = gtk_entry_new(); gtk_entry_set_visibility(GTK_ENTRY(state->secret_entry), FALSE); gtk_entry_set_max_length(GTK_ENTRY(state->secret_entry), 4096); gtk_entry_set_input_purpose(GTK_ENTRY(state->secret_entry), GTK_INPUT_PURPOSE_PASSWORD); gtk_container_add(GTK_CONTAINER(box), state->secret_entry); }
  char *provider = studio_string(data, "providerId"), *url = studio_string(data, "url");
  if (secret && kind && (!strcmp(kind, "device-authorization") || !strcmp(kind, "authorization-url")) && studio_authorization_uri(provider, url)) {
    state->auth_url = g_strdup(url); GtkWidget *open = gtk_button_new_with_label("브라우저에서 인증 열기"); g_signal_connect(open, "clicked", G_CALLBACK(open_auth_url), state); gtk_container_add(GTK_CONTAINER(box), open);
  }
  g_free(provider); g_free(url);
  JSCValue *experimental = jsc_value_object_get_property(data, "experimental");
  if (jsc_value_is_boolean(experimental) && jsc_value_to_boolean(experimental)) {
    GtkWidget *marker = gtk_label_new(NULL); gtk_label_set_markup(GTK_LABEL(marker), "<span foreground='#f59e0b' weight='bold'>(exp!) 실험적 인증 방식</span>"); gtk_container_add(GTK_CONTAINER(box), marker);
  }
  g_object_unref(experimental);
  g_signal_connect(state->dialog, "response", G_CALLBACK(dialog_response), state); state->dialog_timeout = g_timeout_add((guint)MIN(remaining, 120000.0), dialog_expired, state); gtk_widget_show_all(state->dialog);
  g_free(origin); g_free(question);
}
static void renderer_result(Studio *state, const char *id, JSCValue *result) {
  JSCValue *response = jsc_value_new_object(state->json, NULL, NULL), *safe = studio_safe_value(result, 0);
  protocol(response); set_string(response, "id", id); jsc_value_object_set_property(response, "result", safe); to_renderer(state, response); g_object_unref(safe); g_object_unref(response);
}
static void hide_preview(Studio *state) {
  state->preview_generation++;
  g_clear_pointer(&state->preview_origin, g_free); g_clear_pointer(&state->preview_base, g_free);
  if (state->preview) { gtk_widget_hide(GTK_WIDGET(state->preview)); webkit_web_view_stop_loading(state->preview); webkit_web_view_load_uri(state->preview, "about:blank"); }
}
static void preview_filter_ready(GObject *source, GAsyncResult *result, gpointer data) {
  PreviewLoad *load = data; Studio *state = load->state; GError *error = NULL;
  WebKitUserContentFilter *filter = webkit_user_content_filter_store_save_finish(WEBKIT_USER_CONTENT_FILTER_STORE(source), result, &error);
  gboolean valid = filter && !state->stopping && load->generation == state->preview_generation;
  GtkAllocation view; gtk_widget_get_allocation(GTK_WIDGET(state->view), &view);
  gint width = MIN(load->rect[2], view.width - load->rect[0]), height = MIN(load->rect[3], view.height - load->rect[1]);
  valid = valid && width >= 16 && height >= 16;
  if (valid) {
    WebKitUserContentManager *manager = webkit_web_view_get_user_content_manager(state->preview);
    webkit_user_content_manager_remove_all_filters(manager); webkit_user_content_manager_add_filter(manager, filter);
    GUri *parsed = g_uri_parse(load->uri, G_URI_FLAGS_NONE, NULL);
    g_free(state->preview_origin); state->preview_origin = g_strdup_printf("http://127.0.0.1:%d", g_uri_get_port(parsed)); g_uri_unref(parsed);
    g_free(state->preview_base); state->preview_base = g_strdup(load->uri);
    gtk_fixed_move(GTK_FIXED(state->preview_layer), GTK_WIDGET(state->preview), load->rect[0], load->rect[1]);
    gtk_widget_set_size_request(GTK_WIDGET(state->preview), width, height);
    webkit_web_view_load_uri(state->preview, load->uri); gtk_widget_show(GTK_WIDGET(state->preview));
    JSCValue *ok = jsc_value_new_object(state->json, NULL, NULL); set_string(ok, "status", "shown"); renderer_result(state, load->reply, ok); g_object_unref(ok);
  } else if (!state->stopping) renderer_error(state, load->reply, load->generation != state->preview_generation ? "COMMAND_CANCELLED" : "TOOL_UNAVAILABLE");
  if (filter) webkit_user_content_filter_unref(filter);
  g_clear_error(&error); g_free(load->uri); g_free(load->reply); g_free(load);
}
static gboolean preview_url(Studio *state, JSCValue *value, Pending *pending) {
  char *uri = studio_string(value, "url"); if (!uri) uri = studio_string(value, "readonlyURL");
  if (!studio_preview_uri(uri) || pending->preview_generation != state->preview_generation) { g_free(uri); return FALSE; }
  if (!state->filter_store) {
    state->filter_directory = g_dir_make_tmp("zuku-studio-filter-XXXXXX", NULL);
    if (!state->filter_directory) { g_free(uri); return FALSE; }
    state->filter_store = webkit_user_content_filter_store_new(state->filter_directory);
  }
  /* WebResource::sent-request is observational. The content blocker operates
   * before requests, and is installed before loading the untrusted snapshot. */
  char *escaped = g_regex_escape_string(uri, -1), *pattern = g_strconcat("^", escaped, "[^?#%]*$", NULL); g_free(escaped);
  JSCValue *text = jsc_value_new_string(state->json, pattern); char *quoted = jsc_value_to_json(text, 0); g_object_unref(text); g_free(pattern);
  char *rules = g_strdup_printf("[{\"trigger\":{\"url-filter\":\".*\"},\"action\":{\"type\":\"block\"}},{\"trigger\":{\"url-filter\":%s},\"action\":{\"type\":\"ignore-previous-rules\"}}]", quoted); g_free(quoted);
  GBytes *bytes = g_bytes_new_take(rules, strlen(rules)); PreviewLoad *load = g_new0(PreviewLoad, 1); load->state = state; load->uri = uri; load->reply = g_strdup(pending->reply_id); load->generation = pending->preview_generation; memcpy(load->rect, pending->rect, sizeof(load->rect));
  webkit_user_content_filter_store_save(state->filter_store, "snapshot", bytes, state->cancel, preview_filter_ready, load); g_bytes_unref(bytes); return TRUE;
}
static void host_line(Studio *state, const char *line, gsize length) {
  JSCValue *value = studio_parse(state->json, line, length);
  if (!value || !studio_protocol_version(value)) { g_clear_object(&value); log_line(state, "코어 통신 형식이 맞지 않습니다. 업데이트를 확인해 주세요."); shutdown_host(state); return; }
  char *id = studio_string(value, "id"), *type = studio_string(value, "type");
  if (id && studio_identifier(id)) {
    Pending *pending = g_hash_table_lookup(state->pending, id);
    if (pending) {
      JSCValue *result = jsc_value_object_get_property(value, "result"), *error = jsc_value_object_get_property(value, "error");
      const char *reply = pending->reply_id ? pending->reply_id : id;
      if (!jsc_value_is_undefined(error)) {
        JSCValue *safe = studio_safe_value(error, 0); char *code = studio_string(safe, "code");
        gboolean valid_code = code && strlen(code) <= 64;
        for (const char *p = code; p && *p; p++) if (!g_ascii_isupper(*p) && !g_ascii_isdigit(*p) && *p != '_') valid_code = FALSE;
        if (!g_str_has_prefix(reply, "native_")) renderer_error(state, reply, valid_code ? code : "CORE_OPERATION_FAILED");
        g_free(code); g_object_unref(safe);
      } else if (!strcmp(pending->method, "native.resolvePreview")) {
        if (!preview_url(state, result, pending) && !g_str_has_prefix(reply, "native_")) renderer_error(state, reply, "TOOL_UNAVAILABLE");
      } else if (!g_str_has_prefix(reply, "native_")) renderer_result(state, reply, result);
      g_object_unref(result); g_object_unref(error); g_hash_table_remove(state->pending, id);
    }
  } else if (type) {
    JSCValue *data = jsc_value_object_get_property(value, "data");
    if (!strcmp(type, "host.ready")) {
      char *status = studio_string(data, "status");
      if (!g_strcmp0(status, "ready") && studio_protocol_version(data)) gtk_label_set_text(GTK_LABEL(state->status), "로컬 코어 연결됨");
      g_free(status);
    } else if (!strcmp(type, "native.pairing")) native_prompt(state, data, FALSE);
    else if (!strcmp(type, "native.auth")) native_prompt(state, data, TRUE);
    else if ((!strcmp(type, "native.pairingClosed") || !strcmp(type, "native.authClosed")) && state->dialog) {
      char *request = studio_string(data, "requestId"); if (!g_strcmp0(request, state->dialog_request)) gtk_dialog_response(GTK_DIALOG(state->dialog), GTK_RESPONSE_CANCEL); g_free(request);
    } else if (!strcmp(type, "native.subscription")) {
      char *subscription = studio_string(data, "subscriptionId");
      JSCValue *event = jsc_value_object_get_property(data, "event"), *status = jsc_value_object_get_property(data, "status");
      if (studio_identifier(subscription) && (studio_core_event(event) || !jsc_value_is_undefined(status))) {
        JSCValue *out = jsc_value_new_object(state->json, NULL, NULL), *payload = jsc_value_new_object(state->json, NULL, NULL);
        protocol(out); set_string(out, "type", "native.subscription"); set_string(payload, "subscriptionId", subscription);
        if (studio_core_event(event)) jsc_value_object_set_property(payload, "event", event);
        else {
          char *kind = studio_string(status, "kind"), *phase = studio_string(status, "state");
          if (!g_strcmp0(kind, "status") && phase && (!strcmp(phase, "connected") || !strcmp(phase, "disconnected") || !strcmp(phase, "cursor_expired") || !strcmp(phase, "closed"))) {
            JSCValue *safe = jsc_value_new_object(state->json, NULL, NULL); set_string(safe, "kind", "status"); set_string(safe, "state", phase);
            JSCValue *minimum = jsc_value_object_get_property(status, "minimumSequence");
            double sequence = jsc_value_is_number(minimum) ? jsc_value_to_double(minimum) : -1;
            if (isfinite(sequence) && sequence >= 0 && sequence <= 9007199254740991.0 && floor(sequence) == sequence) jsc_value_object_set_property(safe, "minimumSequence", minimum);
            g_object_unref(minimum); jsc_value_object_set_property(payload, "status", safe); g_object_unref(safe);
          }
          g_free(kind); g_free(phase);
        }
        jsc_value_object_set_property(out, "data", payload); to_renderer(state, out); g_object_unref(payload); g_object_unref(out);
      }
      g_free(subscription); g_object_unref(event); g_object_unref(status);
    }
    g_object_unref(data);
  }
  g_free(id); g_free(type); g_object_unref(value);
}
static void read_host(GObject *source, GAsyncResult *result, gpointer data) {
  Studio *state = data; state->read_inflight = FALSE; GError *error = NULL; GBytes *bytes = g_input_stream_read_bytes_finish(G_INPUT_STREAM(source), result, &error);
  if (!bytes || !g_bytes_get_size(bytes) || error) { if (!state->stopping) host_unavailable(state); g_clear_pointer(&bytes, g_bytes_unref); g_clear_error(&error); return; }
  gsize length; const guint8 *chunk = g_bytes_get_data(bytes, &length); g_byte_array_append(state->incoming, chunk, (guint)length); g_bytes_unref(bytes);
  consume_host(state);
}
static void consume_host(Studio *state) {
  if (!state->host || state->host_dead || state->stopping) return;
  guint8 *newline;
  while (g_queue_get_length(&state->render_queue) < 48 && state->render_bytes < STUDIO_QUEUE_BYTES / 2 && (newline = memchr(state->incoming->data, '\n', state->incoming->len))) {
    gsize size = (gsize)(newline - state->incoming->data); if (size) host_line(state, (char *)state->incoming->data, size);
    g_byte_array_remove_range(state->incoming, 0, (guint)size + 1); if (state->stopping) return;
  }
  if (state->incoming->len > STUDIO_RESPONSE_BYTES && !memchr(state->incoming->data, '\n', state->incoming->len)) { log_line(state, "코어 통신 메시지의 크기 한도를 초과했습니다."); shutdown_host(state); return; }
  if (!state->read_inflight && g_queue_get_length(&state->render_queue) < 48 && state->render_bytes < STUDIO_QUEUE_BYTES / 2) {
    state->read_inflight = TRUE; g_input_stream_read_bytes_async(g_subprocess_get_stdout_pipe(state->host), 4096, G_PRIORITY_DEFAULT, state->cancel, read_host, state);
  }
}
static void host_exited(GObject *source, GAsyncResult *result, gpointer data) {
  Studio *state = data; GError *error = NULL; (void)g_subprocess_wait_finish(G_SUBPROCESS(source), result, &error); g_clear_error(&error); state->host_dead = TRUE;
  if (!state->stopping) host_unavailable(state);
  if (state->held) { state->held = FALSE; g_application_release(G_APPLICATION(state->application)); }
}
static void start_host(Studio *state) {
  if (state->host) return;
  if (!trusted_ui() || !trusted_file(studio_runtime_node, TRUE) || !trusted_file(host_entry, FALSE)) { log_line(state, "STUDIO_CORE_UNAVAILABLE · 관리된 Node 코어 또는 로컬 앱 파일을 검증하지 못했습니다."); gtk_label_set_text(GTK_LABEL(state->status), "STUDIO_CORE_UNAVAILABLE · 설치 파일을 확인해 주세요."); return; }
  GSubprocessLauncher *launcher = g_subprocess_launcher_new(G_SUBPROCESS_FLAGS_STDIN_PIPE | G_SUBPROCESS_FLAGS_STDOUT_PIPE | G_SUBPROCESS_FLAGS_STDERR_SILENCE);
  char *directory = g_path_get_dirname(host_entry); g_subprocess_launcher_set_cwd(launcher, directory); g_free(directory);
  g_subprocess_launcher_unsetenv(launcher, "NODE_OPTIONS"); g_subprocess_launcher_unsetenv(launcher, "NODE_PATH");
  const char *argv[] = { studio_runtime_node, host_entry, "--stdio", NULL }; GError *error = NULL;
  state->host = g_subprocess_launcher_spawnv(launcher, argv, &error); g_object_unref(launcher);
  if (!state->host) { g_clear_error(&error); host_unavailable(state); return; }
  g_application_hold(G_APPLICATION(state->application)); state->held = TRUE;
  state->read_inflight = TRUE; g_input_stream_read_bytes_async(g_subprocess_get_stdout_pipe(state->host), 4096, G_PRIORITY_DEFAULT, state->cancel, read_host, state);
  g_subprocess_wait_async(state->host, NULL, host_exited, state);
}
static gboolean kill_host(gpointer data) { Studio *state = data; if (state->host && !state->host_dead) g_subprocess_force_exit(state->host); return G_SOURCE_REMOVE; }
static void shutdown_host(Studio *state) {
  if (state->stopping) return;
  state->stopping = TRUE; g_cancellable_cancel(state->cancel);
  if (state->dialog) gtk_dialog_response(GTK_DIALOG(state->dialog), GTK_RESPONSE_CANCEL);
  if (state->host && !state->host_dead) { g_subprocess_send_signal(state->host, SIGTERM); g_timeout_add(2000, kill_host, state); }
}
static gboolean project_path(const char *path) {
  if (!path || strlen(path) > 4096 || !g_path_is_absolute(path) || !g_utf8_validate(path, -1, NULL)) return FALSE;
  struct stat info; if (stat(path, &info) || !S_ISDIR(info.st_mode)) return FALSE;
  const char *home = g_get_home_dir(); gsize n = strlen(path);
  if (!strcmp(path, "/") || !strcmp(path, home) || (g_str_has_prefix(home, path) && home[n] == '/')) return FALSE;
  char **parts = g_strsplit(path, "/", -1); gboolean valid = TRUE;
  for (gsize i = 0; parts[i]; i++) if (!strcmp(parts[i], ".ssh") || !strcmp(parts[i], ".config") || !strcmp(parts[i], ".aws") || !strcmp(parts[i], ".codex") || !strcmp(parts[i], ".claude") || !strcmp(parts[i], ".git")) valid = FALSE;
  g_strfreev(parts); return valid;
}
static gboolean preview_resource_uri(Studio *state, const char *uri) {
  if (!g_strcmp0(uri, "about:blank")) return TRUE;
  if (!uri || !state->preview_base || !g_str_has_prefix(uri, state->preview_base) || strchr(uri, '%') || strchr(uri, '?') || strchr(uri, '#') || strchr(uri, '\\')) return FALSE;
  const char *relative = uri + strlen(state->preview_base);
  char **parts = g_strsplit(relative, "/", -1); gboolean safe = TRUE;
  for (gsize i = 0; parts[i]; i++) if (!strcmp(parts[i], ".") || !strcmp(parts[i], "..")) safe = FALSE;
  g_strfreev(parts); return safe;
}
static int native_boundary_tests(void) {
  Studio state = { 0 }; state.preview_base = "http://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/";
  g_assert_true(preview_resource_uri(&state, state.preview_base));
  g_assert_true(preview_resource_uri(&state, "http://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/assets/game.mjs"));
  const char *denied[] = { "http://127.0.0.1:45678/api/", "http://127.0.0.1:45678/p/1123456789abcdef0123456789abcdef/", "http://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/../api/", "http://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/%2e%2e/api/", "http://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/?token=fixture", "http://127.0.0.1:45679/p/0123456789abcdef0123456789abcdef/", "http://user@127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/", "file:///etc/passwd", NULL };
  for (gsize i = 0; denied[i]; i++) g_assert_false(preview_resource_uri(&state, denied[i]));
  g_print("Studio preview boundary: 10 immutable-snapshot path assertions passed; no GUI or network started.\n"); return 0;
}
static void chooser_response(GtkNativeDialog *dialog, gint response, gpointer data) {
  Studio *state = data;
  const char *id = state->chooser_id;
  if (response == GTK_RESPONSE_ACCEPT) {
    char *selection = gtk_file_chooser_get_filename(GTK_FILE_CHOOSER(dialog)); char *path = selection ? realpath(selection, NULL) : NULL;
    if (project_path(path)) {
      JSCValue *params = jsc_value_new_object(state->json, NULL, NULL); set_string(params, "requestId", id); set_string(params, "localPath", path);
      if (!send_rpc(state, id, "native.projectChosen", params, FALSE)) renderer_error(state, id, "HOST_QUEUE_FULL");
      g_object_unref(params);
    } else renderer_error(state, id, "PROJECT_NOT_ALLOWED");
    g_free(selection); free(path);
  } else renderer_error(state, id, "CANCELLED");
  state->chooser = NULL; g_clear_pointer(&state->chooser_id, g_free); g_object_unref(dialog);
}
static void choose_project(Studio *state, const char *id) {
  if (state->chooser) { renderer_error(state, id, "REQUEST_IN_PROGRESS"); gtk_native_dialog_show(GTK_NATIVE_DIALOG(state->chooser)); return; }
  state->chooser_id = g_strdup(id);
  state->chooser = gtk_file_chooser_native_new("게임 프로젝트 폴더 선택", GTK_WINDOW(state->window), GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER, "이 폴더 열기", "취소");
  g_signal_connect(state->chooser, "response", G_CALLBACK(chooser_response), state); gtk_native_dialog_show(GTK_NATIVE_DIALOG(state->chooser));
}
static void script_message(WebKitUserContentManager *manager, WebKitJavascriptResult *result, gpointer data) {
  (void)manager; Studio *state = data;
  if (state->stopping || g_strcmp0(webkit_web_view_get_uri(state->view), state->page_uri)) return;
  JSCValue *raw = webkit_javascript_result_get_js_value(result); char *encoded = jsc_value_is_string(raw) ? jsc_value_to_string(raw) : NULL;
  JSCValue *request = encoded && strlen(encoded) <= STUDIO_LINE_BYTES ? studio_parse(state->json, encoded, strlen(encoded)) : NULL; g_free(encoded);
  if (!request || !studio_renderer_request(request)) { g_clear_object(&request); return; }
  char *id = studio_string(request, "id"), *method = studio_string(request, "method"); JSCValue *params = jsc_value_object_get_property(request, "params");
  if (!strcmp(method, "native.pickProject")) choose_project(state, id);
  else if (!strcmp(method, "native.previewHide")) { hide_preview(state); JSCValue *ok = jsc_value_new_object(state->json, NULL, NULL); set_string(ok, "status", "hidden"); renderer_result(state, id, ok); g_object_unref(ok); }
  else if (!strcmp(method, "native.previewShow")) {
    hide_preview(state);
    char *uuid = g_uuid_string_random(), *internal = g_strconcat("native_", uuid, NULL); g_free(uuid);
    JSCValue *private = jsc_value_new_object(state->json, NULL, NULL), *handle = jsc_value_object_get_property(params, "previewHandle");
    jsc_value_object_set_property(private, "previewHandle", handle); g_object_unref(handle);
    if (send_rpc(state, internal, "native.resolvePreview", private, FALSE)) {
      Pending *pending = g_hash_table_lookup(state->pending, internal); pending->reply_id = g_strdup(id); pending->preview_generation = state->preview_generation;
      JSCValue *rect = jsc_value_object_get_property(params, "rect"); const char *keys[] = { "x", "y", "width", "height" };
      for (gsize i = 0; i < G_N_ELEMENTS(keys); i++) { JSCValue *entry = jsc_value_object_get_property(rect, keys[i]); pending->rect[i] = (gint)jsc_value_to_double(entry); g_object_unref(entry); }
      g_object_unref(rect);
    } else renderer_error(state, id, "HOST_QUEUE_FULL");
    g_object_unref(private); g_free(internal);
  }
  else if (!send_rpc(state, id, method, params, FALSE)) renderer_error(state, id, "HOST_QUEUE_FULL");
  g_free(id); g_free(method); g_object_unref(params); g_object_unref(request);
}
static gboolean navigation(WebKitWebView *view, WebKitPolicyDecision *decision, WebKitPolicyDecisionType type, gpointer data) {
  Studio *state = data;
  if (type == WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION || type == WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) {
    WebKitNavigationAction *action = webkit_navigation_policy_decision_get_navigation_action(WEBKIT_NAVIGATION_POLICY_DECISION(decision));
    const char *uri = webkit_uri_request_get_uri(webkit_navigation_action_get_request(action));
    gboolean allow = type != WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION && (view == state->view ? !g_strcmp0(uri, state->page_uri) : preview_resource_uri(state, uri));
    if (!allow) { webkit_policy_decision_ignore(decision); return TRUE; }
  }
  return FALSE;
}
static void asset_request(WebKitURISchemeRequest *request, gpointer data) {
  (void)data; const char *uri = webkit_uri_scheme_request_get_uri(request), *name = NULL;
  for (gsize i = 0; assets[i]; i++) { char *allowed = g_strconcat("zuku-studio://app/", assets[i], NULL); if (!g_strcmp0(uri, allowed)) name = assets[i]; g_free(allowed); if (name) break; }
  char *path = name ? g_build_filename(installation_root, name, NULL) : NULL, *bytes = NULL; gsize length = 0;
  if (!path || !trusted_file(path, FALSE) || !g_file_get_contents(path, &bytes, &length, NULL) || length > 1048576) {
    GError *error = g_error_new_literal(G_IO_ERROR, G_IO_ERROR_PERMISSION_DENIED, "Trusted application resource unavailable");
    webkit_uri_scheme_request_finish_error(request, error); g_error_free(error); g_free(path); g_free(bytes); return;
  }
  const char *mime = g_str_has_suffix(name, ".html") ? "text/html" : g_str_has_suffix(name, ".css") ? "text/css" : "text/javascript";
  GInputStream *stream = g_memory_input_stream_new_from_data(bytes, (gssize)length, g_free);
  /* Custom local schemes have an opaque origin in module fetches. These are
   * public, immutable UI assets; the exact URI allowlist remains the authority. */
  WebKitURISchemeResponse *response = webkit_uri_scheme_response_new(stream, (gint64)length);
  webkit_uri_scheme_response_set_content_type(response, mime); webkit_uri_scheme_response_set_status(response, 200, NULL);
  SoupMessageHeaders *headers = soup_message_headers_new(SOUP_MESSAGE_HEADERS_RESPONSE);
  soup_message_headers_append(headers, "Access-Control-Allow-Origin", "*");
  webkit_uri_scheme_response_set_http_headers(response, headers);
  webkit_uri_scheme_request_finish_with_response(request, response); g_object_unref(response); g_object_unref(stream); g_free(path);
}
static gboolean permission(WebKitWebView *view, WebKitPermissionRequest *request, gpointer data) { (void)view; (void)data; webkit_permission_request_deny(request); return TRUE; }
static WebKitWebView *popup(WebKitWebView *view, WebKitNavigationAction *action, gpointer data) { (void)view; (void)action; (void)data; return NULL; }
static gboolean file_chooser(WebKitWebView *view, WebKitFileChooserRequest *request, gpointer data) { (void)view; (void)data; webkit_file_chooser_request_cancel(request); return TRUE; }
static void loaded(WebKitWebView *view, WebKitLoadEvent event, gpointer data) { Studio *state = data; if (view == state->view && event == WEBKIT_LOAD_STARTED) state->ready = FALSE; else if (view == state->view && event == WEBKIT_LOAD_COMMITTED) state->ready = !g_strcmp0(webkit_web_view_get_uri(view), state->page_uri); }
static gboolean window_closed(GtkWidget *window, GdkEvent *event, gpointer data) { (void)window; (void)event; shutdown_host(data); return FALSE; }
static void activate(GApplication *application, gpointer data) {
  Studio *state = data; if (state->stopping) return;
  if (state->window) { gtk_window_present(GTK_WINDOW(state->window)); return; }
  state->window = gtk_application_window_new(GTK_APPLICATION(application)); gtk_window_set_title(GTK_WINDOW(state->window), "ZUKU Studio"); gtk_window_set_default_size(GTK_WINDOW(state->window), 1440, 880);
  if (!trusted_ui()) { gtk_container_add(GTK_CONTAINER(state->window), gtk_label_new("관리된 로컬 화면 파일을 검증하지 못했습니다. 설치 파일을 확인해 주세요.")); gtk_widget_show_all(state->window); return; }
  GtkWidget *header = gtk_header_bar_new(); gtk_header_bar_set_title(GTK_HEADER_BAR(header), "ZUKU Studio"); gtk_header_bar_set_show_close_button(GTK_HEADER_BAR(header), TRUE); gtk_window_set_titlebar(GTK_WINDOW(state->window), header);
  GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0), *overlay = gtk_overlay_new(); gtk_container_add(GTK_CONTAINER(state->window), box); gtk_box_pack_start(GTK_BOX(box), overlay, TRUE, TRUE, 0);
  state->status = gtk_label_new("로컬 코어 연결 중"); gtk_widget_set_halign(state->status, GTK_ALIGN_START); gtk_box_pack_end(GTK_BOX(box), state->status, FALSE, FALSE, 0);
  state->manager = webkit_user_content_manager_new(); g_signal_connect(state->manager, "script-message-received::zuku", G_CALLBACK(script_message), state); webkit_user_content_manager_register_script_message_handler(state->manager, "zuku");
  WebKitWebContext *main_context = prepared_context; prepared_context = NULL;
  if (!main_context) { log_line(state, "네이티브 화면 초기화 순서가 맞지 않습니다."); gtk_widget_show_all(state->window); return; }
  webkit_web_context_set_sandbox_enabled(main_context, TRUE);
  if (!webkit_web_context_get_sandbox_enabled(main_context)) { log_line(state, "네이티브 화면 격리를 시작하지 못했습니다."); g_object_unref(main_context); gtk_widget_show_all(state->window); return; }
  webkit_web_context_register_uri_scheme(main_context, "zuku-studio", asset_request, state, NULL);
  WebKitSecurityManager *security = webkit_web_context_get_security_manager(main_context);
  webkit_security_manager_register_uri_scheme_as_secure(security, "zuku-studio");
  webkit_security_manager_register_uri_scheme_as_local(security, "zuku-studio");
  webkit_security_manager_register_uri_scheme_as_cors_enabled(security, "zuku-studio");
  state->page_uri = g_strdup("zuku-studio://app/studio/renderer/index.html");
  char *bridge = NULL; gsize bridge_length = 0;
  if (!g_file_get_contents(bridge_file, &bridge, &bridge_length, NULL) || bridge_length > 131072 || memchr(bridge, 0, bridge_length)) { g_free(bridge); g_object_unref(main_context); log_line(state, "네이티브 연결 파일을 읽지 못했습니다."); gtk_widget_show_all(state->window); return; }
  const char *allow[] = { state->page_uri, NULL };
  WebKitUserScript *preload = webkit_user_script_new(bridge, WEBKIT_USER_CONTENT_INJECT_TOP_FRAME, WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START, allow, NULL);
  webkit_user_content_manager_add_script(state->manager, preload); webkit_user_script_unref(preload); g_free(bridge);
  state->view = WEBKIT_WEB_VIEW(g_object_new(WEBKIT_TYPE_WEB_VIEW, "web-context", main_context, "user-content-manager", state->manager, NULL)); g_object_unref(main_context);
  WebKitWebsiteDataManager *preview_data = webkit_website_data_manager_new_ephemeral(); WebKitWebContext *preview_context = webkit_web_context_new_with_website_data_manager(preview_data); g_object_unref(preview_data);
  webkit_web_context_set_sandbox_enabled(preview_context, TRUE);
  if (!webkit_web_context_get_sandbox_enabled(preview_context)) { g_object_unref(preview_context); log_line(state, "미리보기 화면 격리를 시작하지 못했습니다."); gtk_widget_show_all(state->window); return; }
  state->preview = WEBKIT_WEB_VIEW(webkit_web_view_new_with_context(preview_context)); g_object_unref(preview_context);
  WebKitSettings *settings = webkit_settings_new_with_settings("enable-developer-extras", FALSE, "javascript-can-open-windows-automatically", FALSE, "allow-file-access-from-file-urls", FALSE, "allow-universal-access-from-file-urls", FALSE, "enable-html5-database", FALSE, "enable-html5-local-storage", FALSE, NULL);
  webkit_web_view_set_settings(state->view, settings); webkit_web_view_set_settings(state->preview, settings); g_object_unref(settings);
  gtk_container_add(GTK_CONTAINER(overlay), GTK_WIDGET(state->view));
  state->preview_layer = gtk_fixed_new(); gtk_widget_set_halign(state->preview_layer, GTK_ALIGN_FILL); gtk_widget_set_valign(state->preview_layer, GTK_ALIGN_FILL);
  gtk_overlay_add_overlay(GTK_OVERLAY(overlay), state->preview_layer); gtk_overlay_set_overlay_pass_through(GTK_OVERLAY(overlay), state->preview_layer, FALSE);
  gtk_fixed_put(GTK_FIXED(state->preview_layer), GTK_WIDGET(state->preview), 0, 0); gtk_widget_set_no_show_all(GTK_WIDGET(state->preview), TRUE);
  WebKitWebView *views[] = { state->view, state->preview };
  for (gsize i = 0; i < G_N_ELEMENTS(views); i++) { g_signal_connect(views[i], "decide-policy", G_CALLBACK(navigation), state); g_signal_connect(views[i], "permission-request", G_CALLBACK(permission), state); g_signal_connect(views[i], "create", G_CALLBACK(popup), state); g_signal_connect(views[i], "run-file-chooser", G_CALLBACK(file_chooser), state); }
  g_signal_connect(state->view, "load-changed", G_CALLBACK(loaded), state); g_signal_connect(state->window, "delete-event", G_CALLBACK(window_closed), state);
  start_host(state); webkit_web_view_load_uri(state->view, state->page_uri); webkit_web_view_load_uri(state->preview, "about:blank");
  state->pending_timer = g_timeout_add_seconds(5, pending_expiry, state); gtk_widget_show_all(state->window);
}
static void opened(GApplication *application, GFile **files, gint count, const gchar *hint, gpointer data) {
  (void)hint; Studio *state = data; activate(application, data);
  if (count != 1) return;
  char *uri = g_file_get_uri(files[0]); if (studio_connect_uri(uri)) gtk_label_set_text(GTK_LABEL(state->status), "웹 화면의 연결 요청을 기다립니다. 승인 창에서 직접 허용해 주세요.");
  g_free(uri);
}
int main(int argc, char **argv) {
  const char *node_option = NULL;
  if (argc >= 3 && !strcmp(argv[1], "--managed-node")) { node_option = argv[2]; for (int i = 1; i + 2 <= argc; i++) argv[i] = argv[i + 2]; argc -= 2; }
  gboolean diagnostic = argc == 2 && (!strcmp(argv[1], "--self-test") || !strcmp(argv[1], "--stdio-test") || !strcmp(argv[1], "--validate-request") || !strcmp(argv[1], "--version"));
  if (!diagnostic) {
    if (geteuid() == 0) { g_printerr("STUDIO_USER_REQUIRED: start the native app as an ordinary desktop user.\n"); return 2; }
    if (argc > 2 || (argc == 2 && !studio_connect_uri(argv[1]))) { g_printerr("STUDIO_ARGUMENT_NOT_ALLOWED: only zuku://ai/connect may open the native app.\n"); return 2; }
    g_unsetenv("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS"); g_unsetenv("WEBKIT_DISABLE_COMPOSITING_MODE");
    if (!initialize_gui()) { g_printerr("STUDIO_DISPLAY_UNAVAILABLE: a sandboxed desktop session could not be initialized.\n"); return 2; }
  }
  if (!locate_installation(node_option)) { g_printerr("STUDIO_INSTALL_UNAVAILABLE: managed installation or runtime could not be verified.\n"); return 2; }
  if (argc == 2 && !strcmp(argv[1], "--self-test")) { int status = studio_protocol_tests(); return status ? status : native_boundary_tests(); }
  if (argc == 2 && !strcmp(argv[1], "--stdio-test")) return studio_stdio_tests();
  if (argc == 2 && !strcmp(argv[1], "--validate-request")) {
    char bytes[STUDIO_LINE_BYTES + 1]; gsize length = fread(bytes, 1, sizeof(bytes), stdin); JSCContext *context = jsc_context_new();
    if (!studio_load_schema(context, studio_runtime_schema)) { g_object_unref(context); return 2; }
    JSCValue *request = length <= STUDIO_LINE_BYTES ? studio_parse(context, bytes, length) : NULL;
    gboolean valid = request && studio_renderer_request(request); g_clear_object(&request); g_object_unref(context);
    g_print("%s\n", valid ? "ACCEPT" : "REJECT"); return valid ? 0 : 1;
  }
  if (argc == 2 && !strcmp(argv[1], "--version")) { g_print("ZUKU Studio 0.3.0 (Linux integration candidate)\n"); return 0; }
  app.json = jsc_context_new(); app.cancel = g_cancellable_new(); app.incoming = g_byte_array_new(); app.pending = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, pending_free); g_queue_init(&app.queue); g_queue_init(&app.render_queue);
  if (!studio_load_schema(app.json, studio_runtime_schema)) { g_printerr("STUDIO_SCHEMA_UNAVAILABLE: protocol schema could not be loaded.\n"); return 2; }
  app.application = gtk_application_new("com.zuku.Studio", G_APPLICATION_HANDLES_OPEN); g_signal_connect(app.application, "activate", G_CALLBACK(activate), &app); g_signal_connect(app.application, "open", G_CALLBACK(opened), &app);
  int status = g_application_run(G_APPLICATION(app.application), argc, argv); shutdown_host(&app);
  /* The OS releases canceled async callbacks at process exit; their backing buffers
   * remain owned until then, so an in-flight writer never observes freed memory. */
  if (!app.writing) { while (!g_queue_is_empty(&app.queue)) outgoing_free(g_queue_pop_head(&app.queue)); }
  g_object_unref(app.application); return status;
}
