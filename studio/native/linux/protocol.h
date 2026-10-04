#ifndef ZUKU_STUDIO_PROTOCOL_H
#define ZUKU_STUDIO_PROTOCOL_H
#include <jsc/jsc.h>
#define STUDIO_LINE_BYTES 65536u
#define STUDIO_RESPONSE_BYTES 262144u
#define STUDIO_QUEUE_BYTES 262144u
#define STUDIO_QUEUE_COUNT 64u
extern const char *studio_runtime_node;
extern const char *studio_runtime_fixture;
extern const char *studio_runtime_schema;
gboolean studio_load_schema(JSCContext *context, const char *path);
JSCValue *studio_parse(JSCContext *context, const char *json, gsize size);
gboolean studio_renderer_request(JSCValue *value);
gboolean studio_protocol_version(JSCValue *value);
gboolean studio_identifier(const char *value);
char *studio_string(JSCValue *value, const char *property);
JSCValue *studio_safe_value(JSCValue *value, unsigned depth);
gboolean studio_preview_uri(const char *uri);
gboolean studio_connect_uri(const char *uri);
gboolean studio_authorization_uri(const char *provider, const char *uri);
gboolean studio_event_type(const char *type);
gboolean studio_core_event(JSCValue *value);
int studio_protocol_tests(void);
int studio_stdio_tests(void);
#endif
