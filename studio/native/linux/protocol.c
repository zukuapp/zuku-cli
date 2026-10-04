#include "protocol.h"
#include <string.h>
#include <math.h>

static gboolean object(JSCValue *value) { return value && jsc_value_is_object(value) && !jsc_value_is_array(value); }
char *studio_string(JSCValue *value, const char *property) {
  if (!object(value)) return NULL;
  JSCValue *member = jsc_value_object_get_property(value, property);
  char *result = jsc_value_is_string(member) ? jsc_value_to_string(member) : NULL;
  g_object_unref(member); return result;
}
static gboolean characters(const char *value, const char *extra, gsize minimum, gsize maximum) {
  if (!value || strlen(value) < minimum || strlen(value) > maximum) return FALSE;
  for (const char *cursor = value; *cursor; cursor++) if (!g_ascii_isalnum(*cursor) && !strchr(extra, *cursor)) return FALSE;
  return TRUE;
}
gboolean studio_identifier(const char *value) { return characters(value, "_-", 1, 128); }
gboolean studio_protocol_version(JSCValue *value) {
  if (!object(value)) return FALSE;
  JSCValue *version = jsc_value_object_get_property(value, "protocolVersion");
  gboolean valid = jsc_value_is_number(version) && jsc_value_to_double(version) == 1;
  g_object_unref(version); return valid;
}
static gboolean only(JSCValue *value, const char *const *allowed) {
  if (!object(value)) return FALSE;
  char **names = jsc_value_object_enumerate_properties(value); gboolean valid = TRUE;
  for (gsize i = 0; names && names[i]; i++) {
    gboolean found = FALSE;
    for (gsize j = 0; allowed[j]; j++) if (!strcmp(names[i], allowed[j])) found = TRUE;
    if (!found) valid = FALSE;
  }
  g_strfreev(names); return valid;
}
static gboolean id_property(JSCValue *value, const char *key) {
  char *id = studio_string(value, key); gboolean valid = studio_identifier(id); g_free(id); return valid;
}
static gboolean integer_property(JSCValue *value, const char *key, double minimum, double maximum) {
  JSCValue *entry = jsc_value_object_get_property(value, key);
  double number = jsc_value_is_number(entry) ? jsc_value_to_double(entry) : -1;
  gboolean valid = isfinite(number) && number >= minimum && number <= maximum && floor(number) == number;
  g_object_unref(entry); return valid;
}

/* The authoritative browser-safe schema is executed in a private JavaScriptCore
 * context. It has no Node/OS imports; there is no independent native schema fork.
 * This private TextEncoder shim implements only the byte-length operation used
 * by schema.mjs; the renderer keeps the browser's actual TextEncoder. */
gboolean studio_load_schema(JSCContext *context, const char *path) {
  gchar *source = NULL; gsize length = 0;
  if (!g_file_get_contents(path, &source, &length, NULL) || length > 131072 || memchr(source, 0, length) || !g_utf8_validate(source, (gssize)length, NULL)) { g_free(source); return FALSE; }
  GRegex *imports = g_regex_new("(?m)^import[ \t]", 0, 0, NULL);
  gboolean imported = g_regex_match(imports, source, 0, NULL); g_regex_unref(imports);
  if (imported) { g_free(source); return FALSE; }
  GRegex *exports = g_regex_new("(?m)^export[ \t]+", 0, 0, NULL);
  char *body = g_regex_replace_literal(exports, source, -1, 0, "", 0, NULL); g_regex_unref(exports); g_free(source);
  if (!body) return FALSE;
  char *script = g_strconcat("(function(){const TextEncoder=class{encode(value){let length=0;for(const c of String(value)){const n=c.codePointAt(0);length+=n<128?1:n<2048?2:n<65536?3:4;}return {length};}};\n", body,
    "\nreturn {validateRequest,validateEvent,projectPublicResult,safeError};})()", NULL); g_free(body);
  jsc_context_clear_exception(context);
  JSCValue *codec = jsc_context_evaluate(context, script, -1); g_free(script);
  gboolean valid = object(codec) && !jsc_context_get_exception(context);
  if (valid) jsc_context_set_value(context, "studioCanonicalSchema", codec);
  g_clear_object(&codec); jsc_context_clear_exception(context); return valid;
}
static JSCValue *canonical(JSCValue *value, const char *name, gboolean native) {
  JSCContext *context = jsc_value_get_context(value);
  JSCValue *codec = jsc_context_get_value(context, "studioCanonicalSchema");
  JSCValue *function = object(codec) ? jsc_value_object_get_property(codec, name) : NULL;
  if (!function || !jsc_value_is_function(function)) { g_clear_object(&function); g_object_unref(codec); return NULL; }
  JSCValue *options = jsc_value_new_object(context, NULL, NULL), *flag = jsc_value_new_boolean(context, native);
  jsc_value_object_set_property(options, "native", flag); g_object_unref(flag);
  JSCValue *args[] = { value, options };
  jsc_context_clear_exception(context);
  JSCValue *result = jsc_value_function_callv(function, 2, args);
  if (jsc_context_get_exception(context)) g_clear_object(&result);
  jsc_context_clear_exception(context); g_object_unref(options); g_object_unref(function); g_object_unref(codec); return result;
}
JSCValue *studio_parse(JSCContext *context, const char *json, gsize size) {
  if (!json || size == 0 || size > STUDIO_RESPONSE_BYTES || memchr(json, 0, size) || !g_utf8_validate(json, (gssize)size, NULL)) return NULL;
  char *copy = g_strndup(json, size); jsc_context_clear_exception(context);
  JSCValue *value = jsc_value_new_from_json(context, copy); g_free(copy);
  if (!value || jsc_context_get_exception(context) || !object(value)) { g_clear_object(&value); jsc_context_clear_exception(context); return NULL; }
  return value;
}
gboolean studio_renderer_request(JSCValue *value) {
  static const char *const outer[] = { "protocolVersion", "id", "method", "params", NULL };
  static const char *const none[] = { NULL };
  static const char *const subscription[] = { "subscriptionId", "sessionId", "afterSequence", NULL };
  static const char *const detach[] = { "subscriptionId", NULL };
  static const char *const preview[] = { "previewHandle", "rect", NULL };
  static const char *const rectangle[] = { "x", "y", "width", "height", NULL };
  static const char *const methods[] = { "hello", "project.list", "project.read", "project.patch", "project.search", "session.create", "session.list", "session.get", "session.input", "session.cancel", "session.close", "provider.list", "provider.use", "provider.add", "provider.remove", "provider.configure", "provider.enable", "provider.disable", "model.list", "model.use", "model.info", "auth.list", "auth.request", "auth.logout", "game.run", "game.stop", "game.preview", NULL };
  if (!studio_protocol_version(value) || !only(value, outer) || !id_property(value, "id")) return FALSE;
  char *method = studio_string(value, "method");
  JSCValue *params = jsc_value_object_get_property(value, "params"); gboolean valid = FALSE;
  if (method && (!strcmp(method, "native.pickProject") || !strcmp(method, "native.previewHide"))) valid = only(params, none);
  else if (method && !strcmp(method, "native.subscribe")) valid = only(params, subscription) && id_property(params, "subscriptionId") && id_property(params, "sessionId") && integer_property(params, "afterSequence", 0, 9007199254740991.0);
  else if (method && !strcmp(method, "native.unsubscribe")) valid = only(params, detach) && id_property(params, "subscriptionId");
  else if (method && !strcmp(method, "native.previewShow")) {
    JSCValue *rect = jsc_value_object_get_property(params, "rect");
    valid = only(params, preview) && id_property(params, "previewHandle") && only(rect, rectangle)
      && integer_property(rect, "x", 0, 16384) && integer_property(rect, "y", 0, 16384)
      && integer_property(rect, "width", 16, 16384) && integer_property(rect, "height", 16, 16384);
    g_object_unref(rect);
  } else for (gsize i = 0; method && methods[i]; i++) if (!strcmp(method, methods[i])) {
    JSCValue *admitted = canonical(value, "validateRequest", TRUE); valid = admitted != NULL; g_clear_object(&admitted); break;
  }
  g_free(method); g_object_unref(params); return valid;
}
JSCValue *studio_safe_value(JSCValue *value, unsigned depth) {
  (void)depth;
  JSCValue *result = canonical(value, "projectPublicResult", FALSE);
  return result ? result : jsc_value_new_null(jsc_value_get_context(value));
}
gboolean studio_core_event(JSCValue *value) {
  JSCValue *admitted = canonical(value, "validateEvent", FALSE);
  gboolean valid = admitted != NULL; g_clear_object(&admitted); return valid;
}
gboolean studio_preview_uri(const char *uri) {
  if (!uri || strlen(uri) > 200) return FALSE;
  GError *error = NULL; GUri *parsed = g_uri_parse(uri, G_URI_FLAGS_NONE, &error);
  gboolean valid = parsed && g_strcmp0(g_uri_get_scheme(parsed), "http") == 0 && g_strcmp0(g_uri_get_host(parsed), "127.0.0.1") == 0 && g_uri_get_port(parsed) > 0 && g_uri_get_userinfo(parsed) == NULL && g_uri_get_query(parsed) == NULL && g_uri_get_fragment(parsed) == NULL && g_regex_match_simple("^/p/[a-f0-9]{32}/$", g_uri_get_path(parsed), 0, 0);
  if (parsed) g_uri_unref(parsed);
  g_clear_error(&error); return valid;
}
gboolean studio_connect_uri(const char *uri) { return uri && !strcmp(uri, "zuku://ai/connect"); }
gboolean studio_authorization_uri(const char *provider, const char *uri) {
  if (!provider || !uri || strlen(uri) > 8192) return FALSE;
  GUri *parsed = g_uri_parse(uri, G_URI_FLAGS_ENCODED_PATH | G_URI_FLAGS_ENCODED_QUERY, NULL);
  gboolean zuku = !strcmp(provider, "zuku"), codex = !strcmp(provider, "codex");
  gboolean valid = parsed && (zuku || codex) && !g_strcmp0(g_uri_get_scheme(parsed), "https") && !g_uri_get_userinfo(parsed) && !g_uri_get_fragment(parsed) && g_uri_get_port(parsed) == -1
    && !g_strcmp0(g_uri_get_host(parsed), zuku ? "www.zuzunza.com" : "auth.openai.com") && !g_strcmp0(g_uri_get_path(parsed), zuku ? "/oauth/device" : "/api/accounts/authorize");
  if (valid && g_uri_get_query(parsed)) {
    static const char *const fields[] = { "client_id", "ext_agent_host_id", "response_type", "redirect_uri", "scope", "resource", "state", "nonce", "code_challenge", "code_challenge_method", "agent_name_hint", NULL };
    char **parts = g_strsplit(g_uri_get_query(parsed), "&", -1); GHashTable *seen = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    for (gsize i = 0; parts[i] && valid; i++) {
      if (!*parts[i]) continue;
      char **pair = g_strsplit(parts[i], "=", 2); char *key = g_uri_unescape_string(pair[0], NULL), *value = g_uri_unescape_string(pair[1] ? pair[1] : "", NULL);
      gboolean allowed = FALSE;
      if (zuku) allowed = key && !strcmp(key, "user_code") && value && g_regex_match_simple("^[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}$", value, 0, 0);
      else for (gsize j = 0; fields[j]; j++) if (!g_strcmp0(key, fields[j])) allowed = TRUE;
      valid = allowed && key && value && !g_hash_table_contains(seen, key);
      for (const char *p = value; p && *p; p++) if ((guchar)*p < 0x20 || (guchar)*p == 0x7f) valid = FALSE;
      if (key) g_hash_table_add(seen, key);
      g_free(value); g_strfreev(pair);
    }
    g_hash_table_unref(seen); g_strfreev(parts);
  }
  if (parsed) g_uri_unref(parsed);
  return valid;
}
gboolean studio_event_type(const char *type) {
  static const char *const events[] = { "session.created", "session.closed", "agent.started", "agent.delta", "agent.reasoning_status", "agent.completed", "agent.cancelled", "agent.error", "tool.requested", "tool.started", "tool.completed", "tool.failed", "build.started", "build.output", "build.completed", "game.started", "game.stopped", "preview.started", "preview.updated", "provider.changed", "model.changed", "auth.required", "permission.required", NULL };
  for (gsize i = 0; type && events[i]; i++) if (!strcmp(type, events[i])) return TRUE;
  return FALSE;
}
int studio_protocol_tests(void) {
  JSCContext *context = jsc_context_new();
  g_assert_true(studio_load_schema(context, studio_runtime_schema));
  const char *valid[] = {
    "{\"protocolVersion\":1,\"id\":\"request_123\",\"method\":\"project.list\",\"params\":{}}",
    "{\"protocolVersion\":1,\"id\":\"request_123\",\"method\":\"session.input\",\"params\":{\"sessionId\":\"session_123\",\"requestId\":\"input_123\",\"operation\":\"game.maintain\",\"request\":\"게임 점프 동작 추가\",\"experimental\":false}}",
    "{\"protocolVersion\":1,\"id\":\"request_123\",\"method\":\"auth.request\",\"params\":{\"providerId\":\"codex\",\"experimental\":true}}", NULL };
  const char *invalid[] = {
    "[]", "{", "{\"protocolVersion\":1,\"id\":\"request_123\",\"method\":\"project.open\",\"params\":{\"path\":\"/etc\"}}",
    "{\"protocolVersion\":1,\"id\":\"request_123\",\"method\":\"pair.decide\",\"params\":{\"allow\":true}}",
    "{\"protocolVersion\":1,\"id\":\"request_123\",\"method\":\"session.input\",\"params\":{\"sessionId\":\"session_123\",\"requestId\":\"input_123\",\"operation\":\"game.maintain\",\"request\":\"게임\",\"experimental\":false,\"command\":\"cat /private/auth.json\"}}",
    "{\"protocolVersion\":1,\"id\":\"request_123\",\"method\":\"auth.request\",\"params\":{\"providerId\":\"codex\",\"experimental\":true,\"apiKey\":\"secret\"}}",
    "{\"protocolVersion\":0,\"id\":\"request_123\",\"method\":\"project.list\",\"params\":{}}", NULL };
  unsigned passed = 0;
  for (gsize i = 0; valid[i]; i++) { JSCValue *value = studio_parse(context, valid[i], strlen(valid[i])); g_assert_nonnull(value); g_assert_true(studio_renderer_request(value)); g_object_unref(value); passed++; }
  for (gsize i = 0; invalid[i]; i++) { JSCValue *value = studio_parse(context, invalid[i], strlen(invalid[i])); g_assert_true(value == NULL || !studio_renderer_request(value)); g_clear_object(&value); passed++; }
  char *large = g_strnfill(STUDIO_RESPONSE_BYTES + 1, 'x'); g_assert_null(studio_parse(context, large, STUDIO_RESPONSE_BYTES + 1)); g_free(large); passed++;
  g_assert_true(studio_preview_uri("http://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/"));
  const char *urls[] = { "https://evil.example/", "http://localhost:45678/", "http://127.0.0.1:45678/?token=secret", "http://user@127.0.0.1:45678/", "http://127.0.0.1:45678/private", "file:///etc/passwd", NULL };
  for (gsize i = 0; urls[i]; i++) { g_assert_false(studio_preview_uri(urls[i])); passed++; }
  g_assert_true(studio_connect_uri("zuku://ai/connect")); g_assert_false(studio_connect_uri("zuku://ai/connect?token=secret")); passed++;
  const char *sensitive = "{\"id\":\"project_123\",\"name\":\"게임\",\"path\":\"/private\",\"apiKey\":\"synthetic-secret\",\"authMethods\":[{\"id\":\"device\",\"official\":true,\"access_token\":\"synthetic-secret\"}]}";
  JSCValue *value = studio_parse(context, sensitive, strlen(sensitive)), *safe = studio_safe_value(value, 0);
  char *encoded = jsc_value_to_json(safe, 0); g_assert_null(strstr(encoded, "synthetic-secret")); g_assert_null(strstr(encoded, "path")); g_free(encoded); g_object_unref(value); g_object_unref(safe); passed++;
  g_assert_true(studio_authorization_uri("zuku", "https://www.zuzunza.com/oauth/device?user_code=1234-abcd-5678")); passed++;
  g_assert_true(studio_authorization_uri("codex", "https://auth.openai.com/api/accounts/authorize?client_id=fixture&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A32123%2Fauth%2Fcallback&scope=openid&state=fixture&code_challenge=fixture&code_challenge_method=S256&agent_name_hint=zukujs")); passed++;
  const char *auth_urls[] = { "http://www.zuzunza.com/oauth/device", "https://user@www.zuzunza.com/oauth/device", "https://www.zuzunza.com:8443/oauth/device", "https://www.zuzunza.com/oauth/device#fixture", "https://www.zuzunza.com.evil.example/oauth/device", "https://www.zuzunza.com/oauth/device?user_code=1234-abcd-5678&user_code=1234-abcd-5678", "https://www.zuzunza.com/oauth/device?next=https%3A%2F%2Fevil.example", "https://www.zuzunza.com/oauth/device?user_code=bad", NULL };
  for (gsize i = 0; auth_urls[i]; i++) { g_assert_false(studio_authorization_uri("zuku", auth_urls[i])); passed++; }
  g_assert_false(studio_authorization_uri("codex", "https://auth.openai.com/api/accounts/authorize?scope=a&scope=b")); passed++;
  g_assert_false(studio_authorization_uri("codex", "https://auth.openai.com/api/accounts/authorize?unknown=fixture")); passed++;
  g_object_unref(context); g_print("Studio native protocol: %u assertions groups passed; no GUI or host started.\n", passed); return 0;
}
