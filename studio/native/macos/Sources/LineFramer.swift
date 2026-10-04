import Foundation

/// Newline-delimited UTF-8 JSON framing with a hard per-line limit. The buffer never
/// holds more than one read chunk plus one maximum-size line, because the reader stops
/// pulling bytes while the renderer side is applying backpressure.
struct LineFramer: Sendable {
    enum Next: Equatable, Sendable { case line(String), none, overflow, invalidUTF8 }

    let maxLine: Int
    private var buffer: [UInt8] = []
    private var start = 0

    init(maxLine: Int) { self.maxLine = maxLine }

    var buffered: Int { buffer.count - start }

    mutating func append<C: Collection>(_ bytes: C) where C.Element == UInt8 {
        if start > 0 && start >= buffer.count / 2 { buffer.removeFirst(start); start = 0 }
        buffer.append(contentsOf: bytes)
    }

    mutating func next() -> Next {
        while let newline = buffer[start...].firstIndex(of: 0x0A) {
            let line = buffer[start..<newline]
            start = newline + 1
            if line.count > maxLine { return .overflow }
            if line.isEmpty || line.allSatisfy({ $0 == 0x0D || $0 == 0x20 }) { continue }
            guard let text = String(bytes: line, encoding: .utf8), !text.contains("\u{0}") else { return .invalidUTF8 }
            return .line(text)
        }
        return buffered > maxLine ? .overflow : .none
    }
}

/// Bounded outgoing queue: at most `maxCount` lines and `maxBytes` bytes, each line at
/// most `maxLine` bytes. Sensitive lines (native.authResponse) are zeroed once written.
struct OutgoingQueue: Sendable {
    struct Entry: Sendable { var bytes: [UInt8]; var offset: Int; let sensitive: Bool }

    let maxCount: Int, maxBytes: Int, maxLine: Int
    private(set) var entries: [Entry] = []
    private(set) var bytes = 0

    init(maxCount: Int, maxBytes: Int, maxLine: Int) { self.maxCount = maxCount; self.maxBytes = maxBytes; self.maxLine = maxLine }

    var isEmpty: Bool { entries.isEmpty }

    /// `line` excludes the trailing newline; the queue appends it.
    mutating func push(_ line: [UInt8], sensitive: Bool) -> Bool {
        let size = line.count + 1
        guard line.count <= maxLine, !line.contains(0x0A), entries.count < maxCount, bytes + size <= maxBytes else { return false }
        entries.append(Entry(bytes: line + [0x0A], offset: 0, sensitive: sensitive))
        bytes += size
        return true
    }

    /// Calls `write` with the unwritten tail of the head entry; `write` returns bytes written,
    /// 0 for "would block", or -1 for a fatal error. Returns false on a fatal error.
    mutating func drain(_ write: (UnsafeRawBufferPointer) -> Int) -> Bool {
        while !entries.isEmpty {
            let offset = entries[0].offset
            let written = entries[0].bytes.withUnsafeBytes { raw in write(UnsafeRawBufferPointer(rebasing: raw[offset...])) }
            if written < 0 { return false }
            if written == 0 { return true }
            entries[0].offset += written
            if entries[0].offset == entries[0].bytes.count { popHead() }
        }
        return true
    }

    mutating func removeAll() { while !entries.isEmpty { popHead() } }

    private mutating func popHead() {
        var head = entries.removeFirst()
        bytes -= head.bytes.count
        if head.sensitive { head.bytes.withUnsafeMutableBytes { raw in if let base = raw.baseAddress { memset_s(base, raw.count, 0, raw.count) } } }
    }
}
