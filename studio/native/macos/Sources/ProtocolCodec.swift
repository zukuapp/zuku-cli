import Foundation
import JavaScriptCore

/// Runs the shared browser-safe schema (lib/agent-protocol/schema.mjs) plus the private
/// native codec in a JavaScriptCore context that belongs only to this process. No page,
/// renderer or preview can reach it, and there is no independent native schema fork.
@MainActor
final class ProtocolCodec {
    struct Rect: Equatable, Sendable { let x, y, width, height: Int }
    enum RendererRequest: Equatable, Sendable {
        case forward(id: String, method: String, params: String)
        case pickProject(id: String)
        case previewShow(id: String, handle: String, rect: Rect)
        case previewHide(id: String)
        case reject(id: String, code: String)
    }
    struct AuthPrompt: Equatable, Sendable { let requestId, providerId, methodId, question: String; let expiresAt: Double; let experimental: Bool }
    enum HostMessage: Equatable, Sendable {
        case response(id: String, errorCode: String?, result: String, previewURL: String?)
        case deliver(message: String)
        case pairing(requestId: String, purpose: String, expiresAt: Double)
        case pairingInvalid(requestId: String)
        case auth(AuthPrompt)
        case authInvalid(requestId: String)
        case promptClosed(requestId: String)
        case ignored
    }

    private let context: JSContext
    private let codec: JSValue

    /// Mirror of tests/codec-check.mjs `assemble` — keep the two equivalent.
    static func assemble(schema: String, codec: String) -> String? {
        let importLine = #"(?m)^import[ \t]"#, exportLine = #"(?m)^export[ \t]+"#
        guard schema.range(of: importLine, options: .regularExpression) == nil,
              codec.range(of: importLine, options: .regularExpression) == nil,
              codec.range(of: exportLine, options: .regularExpression) == nil,
              let pattern = try? NSRegularExpression(pattern: exportLine) else { return nil }
        let body = pattern.stringByReplacingMatches(in: schema, range: NSRange(schema.startIndex..., in: schema), withTemplate: "")
        return "(function(){'use strict';const TextEncoder=class{encode(value){let length=0;for(const c of String(value)){const n=c.codePointAt(0);length+=n<128?1:n<2048?2:n<65536?3:4;}return {length};}};\n"
            + body + "\n" + codec + "\nreturn ZukuNativeCodec;})()"
    }

    init?(resources: URL) {
        guard let schemaData = try? Data(contentsOf: resources.appendingPathComponent(Installation.schemaPath)), schemaData.count <= 131072,
              let codecData = try? Data(contentsOf: resources.appendingPathComponent(Installation.codecPath)), codecData.count <= 65536,
              let schema = String(data: schemaData, encoding: .utf8), let codecSource = String(data: codecData, encoding: .utf8),
              let script = ProtocolCodec.assemble(schema: schema, codec: codecSource),
              let context = JSContext() else { return nil }
        context.name = "ZUKU Studio native codec"
        // The default exception handler stores into context.exception, which call() checks.
        guard let value = context.evaluateScript(script), context.exception == nil, value.isObject,
              value.forProperty("admitRenderer")?.isObject == true, value.forProperty("admitHost")?.isObject == true else { return nil }
        self.context = context
        self.codec = value
    }

    func admitRenderer(_ text: String) -> RendererRequest? {
        guard text.utf8.count <= HostProcess.Limits.outgoingLine, let out = call("admitRenderer", text), let kind = out.string("kind"),
              let id = out.string("id") else { return nil }
        switch kind {
        case "forward":
            guard let method = out.string("method"), let params = out.string("params") else { return nil }
            return .forward(id: id, method: method, params: params)
        case "pickProject": return .pickProject(id: id)
        case "previewHide": return .previewHide(id: id)
        case "previewShow":
            guard let handle = out.string("previewHandle"), let x = out.int("x"), let y = out.int("y"),
                  let width = out.int("width"), let height = out.int("height") else { return nil }
            return .previewShow(id: id, handle: handle, rect: Rect(x: x, y: y, width: width, height: height))
        case "reject": return .reject(id: id, code: out.string("code") ?? "INVALID_INPUT")
        default: return nil
        }
    }

    /// nil means the host broke the protocol (not JSON, wrong version, bad id).
    func admitHost(_ text: String) -> HostMessage? {
        guard let out = call("admitHost", text), let kind = out.string("kind") else { return nil }
        switch kind {
        case "response":
            guard let id = out.string("id"), let result = out.string("result") else { return nil }
            return .response(id: id, errorCode: out.string("errorCode"), result: result, previewURL: out.string("previewURL"))
        case "deliver":
            guard let message = out.string("message") else { return nil }
            return .deliver(message: message)
        case "pairing":
            guard let request = out.string("requestId"), let purpose = out.string("purpose"), let expires = out.number("expiresAt") else { return nil }
            return .pairing(requestId: request, purpose: purpose, expiresAt: expires)
        case "auth":
            guard let request = out.string("requestId"), let provider = out.string("providerId"), let method = out.string("methodId"),
                  let question = out.string("question"), let expires = out.number("expiresAt") else { return nil }
            return .auth(AuthPrompt(requestId: request, providerId: provider, methodId: method, question: question, expiresAt: expires,
                                    experimental: out.forProperty("experimental")?.isBoolean == true && out.forProperty("experimental")!.toBool()))
        case "pairingInvalid": return out.string("requestId").map { .pairingInvalid(requestId: $0) }
        case "authInvalid": return out.string("requestId").map { .authInvalid(requestId: $0) }
        case "promptClosed": return out.string("requestId").map { .promptClosed(requestId: $0) }
        case "ignored": return .ignored
        default: return nil
        }
    }

    func previewURL(_ text: String) -> Bool {
        guard let out = call("previewURL", text), out.isString else { return false }
        return out.toString() == text
    }

    private func call(_ name: String, _ argument: String) -> JSValue? {
        context.exception = nil
        guard let function = codec.forProperty(name), let result = function.call(withArguments: [argument]),
              context.exception == nil, !result.isNull, !result.isUndefined else { context.exception = nil; return nil }
        return result
    }
}

private extension JSValue {
    func string(_ key: String) -> String? {
        guard let value = forProperty(key), value.isString else { return nil }
        return value.toString()
    }
    func number(_ key: String) -> Double? {
        guard let value = forProperty(key), value.isNumber else { return nil }
        let number = value.toDouble()
        return number.isFinite ? number : nil
    }
    func int(_ key: String) -> Int? {
        guard let number = number(key), number == number.rounded(), abs(number) <= 9_007_199_254_740_991 else { return nil }
        return Int(number)
    }
}

/// Minimal JSON string encoder for envelopes assembled natively (ids, methods, secrets).
enum JSONText {
    static func quoted(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default:
                if scalar.value < 0x20 || scalar.value == 0x7F { out += String(format: "\\u%04x", scalar.value) }
                else { out.unicodeScalars.append(scalar) }
            }
        }
        return out + "\""
    }

    /// `{"protocolVersion":1,"id":…,"method":…,"params":<paramsJSON>}`
    static func request(id: String, method: String, params: String) -> String {
        "{\"protocolVersion\":1,\"id\":\(quoted(id)),\"method\":\(quoted(method)),\"params\":\(params)}"
    }
    static func result(id: String, result: String) -> String { "{\"protocolVersion\":1,\"id\":\(quoted(id)),\"result\":\(result)}" }
    static func error(id: String, code: String) -> String {
        "{\"protocolVersion\":1,\"id\":\(quoted(id)),\"error\":{\"code\":\(quoted(code))}}"
    }

    /// Builds a sensitive request directly into a byte buffer the caller must zero.
    static func sensitiveRequest(id: String, method: String, requestId: String, value: String) -> [UInt8] {
        var bytes: [UInt8] = []
        bytes.reserveCapacity(128 + value.utf8.count * 2)
        bytes.append(contentsOf: Array("{\"protocolVersion\":1,\"id\":\(quoted(id)),\"method\":\(quoted(method)),\"params\":{\"requestId\":\(quoted(requestId)),\"value\":".utf8))
        bytes.append(0x22)
        for byte in value.utf8 {
            switch byte {
            case 0x22: bytes.append(contentsOf: [0x5C, 0x22])
            case 0x5C: bytes.append(contentsOf: [0x5C, 0x5C])
            case 0..<0x20, 0x7F:
                bytes.append(contentsOf: Array(String(format: "\\u%04x", byte).utf8))
            default: bytes.append(byte)
            }
        }
        bytes.append(contentsOf: Array("\"}}".utf8))
        return bytes
    }
}
