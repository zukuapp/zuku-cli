import Foundation

/// The managed Agent Core host child: exactly `<managed node> <lib/studio-host.mjs> --stdio`
/// started with posix_spawn through Foundation.Process. There is no shell and no string
/// command line. Stdout is read through a non-blocking DispatchSource on the main queue
/// and framed as bounded UTF-8 JSON lines; reading pauses while `canDeliver` is false,
/// so a slow renderer applies backpressure to the host pipe instead of growing memory.
@MainActor
final class HostProcess {
    enum Limits {
        static let outgoingLine = 65536
        static let queueCount = 64
        static let queueBytes = 262144
        static let incomingLine = 262144
        static let readChunk = 16384
    }
    enum Stop: Equatable, Sendable { case exited(Int32), protocolViolation, overflow, ioError, launchFailed }

    var onLine: (String) -> Void = { _ in }
    var onStop: (Stop) -> Void = { _ in }
    var canDeliver: () -> Bool = { true }

    private let process = Process()
    private let input = Pipe(), output = Pipe()
    private var readFD: Int32 = -1, writeFD: Int32 = -1
    private var readSource: DispatchSourceRead?, writeSource: DispatchSourceWrite?
    private var readSuspended = false, writeActive = false
    private var framer = LineFramer(maxLine: Limits.incomingLine)
    private var queue = OutgoingQueue(maxCount: Limits.queueCount, maxBytes: Limits.queueBytes, maxLine: Limits.outgoingLine)
    private var reason: Stop?
    private(set) var running = false
    private var ioOpen = false
    private var exitStatus: Int32?

    init(executable: URL, arguments: [String], directory: URL) {
        process.executableURL = executable
        process.arguments = arguments
        process.currentDirectoryURL = directory
        process.environment = HostProcess.environment()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
    }

    /// Inherited environment minus Node/loader injection knobs.
    static func environment() -> [String: String] {
        ProcessInfo.processInfo.environment.filter { key, _ in
            !key.hasPrefix("NODE_") && !key.hasPrefix("DYLD_") && !key.hasPrefix("npm_") && key != "ELECTRON_RUN_AS_NODE"
        }
    }

    func start() -> Bool {
        process.terminationHandler = { finished in
            let status = finished.terminationStatus
            Task { @MainActor in self.processExited(status) }
        }
        do { try process.run() } catch {
            process.terminationHandler = nil
            reason = .launchFailed
            return false
        }
        running = true
        // Keep private duplicates of our pipe ends; Foundation's handles are closed so the
        // dispatch sources own the only parent descriptors and close them on cancel.
        readFD = dup(output.fileHandleForReading.fileDescriptor)
        writeFD = dup(input.fileHandleForWriting.fileDescriptor)
        // Child-side ends are closed by Process.run(); only our parent-side originals are closed here.
        try? output.fileHandleForReading.close()
        try? input.fileHandleForWriting.close()
        guard readFD >= 0, writeFD >= 0 else { fail(.ioError); return false }
        for fd in [readFD, writeFD] { _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) }
        _ = fcntl(writeFD, F_SETNOSIGPIPE, 1)

        let reader = DispatchSource.makeReadSource(fileDescriptor: readFD, queue: .main)
        let readDescriptor = readFD
        reader.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.readable() } }
        reader.setCancelHandler { close(readDescriptor) }
        let writer = DispatchSource.makeWriteSource(fileDescriptor: writeFD, queue: .main)
        let writeDescriptor = writeFD
        writer.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.writable() } }
        writer.setCancelHandler { close(writeDescriptor) }
        readSource = reader; writeSource = writer; ioOpen = true
        reader.activate()
        return true
    }

    /// Queues one JSON line (without newline). False when the bounded queue is full,
    /// the line is too large, or the host is not running.
    func send(_ line: [UInt8], sensitive: Bool) -> Bool {
        guard running, ioOpen, queue.push(line, sensitive: sensitive) else { return false }
        if !writeActive { writeActive = true; writeSource?.resume() }
        return true
    }

    func resumeReading() {
        guard readSuspended, ioOpen else { return }
        readSuspended = false
        readSource?.resume()
        deliver()
    }

    /// Closes stdin (graceful EOF), then SIGTERM, then SIGKILL after `grace` seconds.
    func terminate(grace: TimeInterval = 2) {
        closeIO()
        guard running else { return }
        let pid = process.processIdentifier
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            MainActor.assumeIsolated { if let self, self.running { self.process.terminate() } }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + grace) { [weak self] in
            MainActor.assumeIsolated { if let self, self.running { kill(pid, SIGKILL) } }
        }
    }

    var failure: Stop? { reason }

    private func readable() {
        guard ioOpen else { return }
        guard canDeliver() else { pauseReading(); return }
        var chunk = [UInt8](repeating: 0, count: Limits.readChunk)
        let descriptor = readFD
        let count = chunk.withUnsafeMutableBytes { read(descriptor, $0.baseAddress, $0.count) }
        if count > 0 { framer.append(chunk[0..<count]); deliver() }
        else if count == 0 {   // EOF: every host line has been read.
            readSource?.cancel(); readSource = nil
            if let status = exitStatus { processExited(status) }
        }
        else if errno != EAGAIN && errno != EINTR { fail(.ioError) }
    }

    private func deliver() {
        while ioOpen {
            guard canDeliver() else { pauseReading(); return }
            switch framer.next() {
            case .line(let text): onLine(text)
            case .none: return
            case .overflow: fail(.overflow); return
            case .invalidUTF8: fail(.protocolViolation); return
            }
        }
    }

    private func pauseReading() {
        guard !readSuspended, let source = readSource else { return }
        readSuspended = true
        source.suspend()
    }

    private func writable() {
        guard ioOpen else { return }
        let descriptor = writeFD
        let ok = queue.drain { buffer in
            let written = write(descriptor, buffer.baseAddress, buffer.count)
            if written > 0 { return written }
            return written == 0 || errno == EAGAIN || errno == EINTR ? 0 : -1
        }
        if !ok { fail(.ioError); return }
        if queue.isEmpty && writeActive { writeActive = false; writeSource?.suspend() }
    }

    /// Records the first failure (protocol violation, overflow, I/O) and stops the host.
    func fail(_ stop: Stop) {
        if reason == nil { reason = stop }
        terminate()
    }

    private func closeIO() {
        guard ioOpen else { return }
        ioOpen = false
        queue.removeAll()
        if let source = readSource { source.cancel(); if readSuspended { readSuspended = false; source.resume() } }
        if let source = writeSource { source.cancel(); if !writeActive { writeActive = true; source.resume() } }
        readSource = nil; writeSource = nil
    }

    private func processExited(_ status: Int32) {
        guard running else { return }
        // Drain stdout to EOF first so final responses are not lost; fall back after 1 s.
        if readSource != nil && ioOpen && reason == nil && exitStatus == nil {
            exitStatus = status
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                MainActor.assumeIsolated { self?.finishExit(status) }
            }
            return
        }
        finishExit(status)
    }

    private func finishExit(_ status: Int32) {
        guard running else { return }
        running = false
        process.terminationHandler = nil
        closeIO()
        onStop(reason ?? .exited(status))
    }
}
