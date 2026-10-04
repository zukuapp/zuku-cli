import AppKit

@main
struct ZukuStudioMain {
    @MainActor
    static func main() {
        signal(SIGPIPE, SIG_IGN)
        let arguments = CommandLine.arguments
        if arguments.count == 2 {
            switch arguments[1] {
            case "--version":
                print("ZUKU Studio \(Installation.expectedVersion ?? "unknown") (macOS native shell, \(SelfTest.architecture))")
                exit(0)
            case "--self-test": exit(SelfTest.protocolChecks())
            case "--stdio-test": exit(SelfTest.stdioRoundTrip())
            default: break
            }
        }
        let application = NSApplication.shared
        let delegate = StudioAppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { application.run() }
    }
}

@MainActor
final class StudioAppDelegate: NSObject, NSApplicationDelegate {
    private var controller: StudioController?
    private var terminating = false, replied = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        // LaunchServices already enforces LSMultipleInstancesProhibited; a directly executed
        // second copy focuses the running instance and exits before starting a host.
        if let other = SingleInstance.existing() {
            other.activate(options: [.activateAllWindows])
            exit(0)
        }
        NSApp.mainMenu = MainMenu.build()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = StudioController()
        self.controller = controller
        controller.launch()
    }

    /// LaunchServices delivers `zuku://` here (CFBundleURLTypes). Only the exact,
    /// token-free connect URI is accepted; everything else just focuses the window.
    func application(_ application: NSApplication, open urls: [URL]) {
        if urls.contains(where: ConnectURI.matches) { controller?.handleConnectRequest() } else { controller?.focus() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        controller?.focus()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let controller, !terminating else { return .terminateNow }
        terminating = true
        var synchronous = true, finished = false
        controller.shutdown { [weak self] in
            finished = true
            if !synchronous { self?.replyTerminate() }
        }
        synchronous = false
        if finished { return .terminateNow }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in MainActor.assumeIsolated { self?.replyTerminate() } }
        return .terminateLater
    }

    private func replyTerminate() {
        guard !replied else { return }
        replied = true
        NSApp.reply(toApplicationShouldTerminate: true)
    }
}

enum ConnectURI {
    static let value = "zuku://ai/connect"
    static func matches(_ url: URL) -> Bool { url.absoluteString == value }
}

@MainActor
enum SingleInstance {
    static func existing() -> NSRunningApplication? {
        guard let identifier = Bundle.main.bundleIdentifier else { return nil }
        let me = ProcessInfo.processInfo.processIdentifier
        return NSRunningApplication.runningApplications(withBundleIdentifier: identifier).first { $0.processIdentifier != me && !$0.isTerminated }
    }
}

@MainActor
enum MainMenu {
    static func build() -> NSMenu {
        let main = NSMenu()
        let app = NSMenu(title: "ZUKU Studio")
        app.addItem(withTitle: "ZUKU Studio 정보", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "ZUKU Studio 가리기", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "ZUKU Studio 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let edit = NSMenu(title: "편집")
        edit.addItem(withTitle: "실행 취소", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "실행 복귀", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "오려두기", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "복사하기", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "붙여넣기", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "모두 선택", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let window = NSMenu(title: "윈도우")
        window.addItem(withTitle: "최소화", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "닫기", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        for menu in [app, edit, window] {
            let item = NSMenuItem()
            item.submenu = menu
            main.addItem(item)
        }
        NSApp.windowsMenu = window
        return main
    }
}
