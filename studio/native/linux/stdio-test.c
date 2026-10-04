#include <gio/gio.h>
#include <string.h>
#include "protocol.h"

/* Exercises native C -> Node -> native C pipes with synthetic protocol fixtures.
 * It never starts the real Agent Core, GTK, WebKit, a browser or a network server. */
int studio_stdio_tests(void) {
  const char *messages =
    "{\"protocolVersion\":1,\"id\":\"request_001\",\"method\":\"project.list\",\"params\":{}}\n"
    "{\"protocolVersion\":1,\"id\":\"request_002\",\"method\":\"session.create\",\"params\":{\"projectHandle\":\"project_fixture\"}}\n"
    "{\"protocolVersion\":1,\"id\":\"request_003\",\"method\":\"native.authResponse\",\"params\":{\"requestId\":\"auth_fixture\",\"value\":\"synthetic-fixture-secret\"}}\n";
  GSubprocessLauncher *launcher = g_subprocess_launcher_new(G_SUBPROCESS_FLAGS_STDIN_PIPE | G_SUBPROCESS_FLAGS_STDOUT_PIPE | G_SUBPROCESS_FLAGS_STDERR_SILENCE);
  g_subprocess_launcher_unsetenv(launcher, "NODE_OPTIONS"); g_subprocess_launcher_unsetenv(launcher, "NODE_PATH");
  const char *argv[] = { studio_runtime_node, studio_runtime_fixture, NULL }; GError *error = NULL;
  GSubprocess *child = g_subprocess_launcher_spawnv(launcher, argv, &error); g_object_unref(launcher);
  g_assert_no_error(error); g_assert_nonnull(child);
  char *output = NULL;
  g_assert_true(g_subprocess_communicate_utf8(child, messages, NULL, &output, NULL, &error)); g_assert_no_error(error); g_assert_true(g_subprocess_get_successful(child));
  g_assert_nonnull(output); g_assert_cmpuint(strlen(output), <, STUDIO_LINE_BYTES); g_assert_null(strstr(output, "synthetic-fixture-secret"));
  JSCContext *context = jsc_context_new(); char **lines = g_strsplit(output, "\n", -1); unsigned count = 0;
  for (gsize i = 0; lines[i]; i++) if (*lines[i]) {
    JSCValue *message = studio_parse(context, lines[i], strlen(lines[i])); g_assert_nonnull(message); g_assert_true(studio_protocol_version(message));
    char *id = studio_string(message, "id"); g_assert_true(studio_identifier(id)); g_free(id); g_object_unref(message); count++;
  }
  g_assert_cmpuint(count, ==, 3); g_strfreev(lines); g_free(output); g_object_unref(context); g_object_unref(child);
  g_print("Studio native stdio: 3 versioned C/Node fixture round trips passed; no real core or GUI started.\n"); return 0;
}
