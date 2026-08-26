//
//  ViewController.swift
//  Shared (App)
//
//  The container app exists for one job the extension cannot do: Apple's
//  language packs can only be downloaded from a real UI context, so onboarding
//  lives here. Once a pair is installed, the extension translates offline.
//

import SwiftUI
import Translation
import WebKit

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
typealias PlatformHostingController = UIHostingController
#elseif os(macOS)
import Cocoa
import SafariServices
typealias PlatformViewController = NSViewController
typealias PlatformHostingController = NSHostingController
#endif

let extensionBundleIdentifier = "com.no1joon.quickglot.Extension"

class ViewController: PlatformViewController {

    /// Main.storyboard still wires this outlet, so the property has to exist for
    /// KVC even though the web view is replaced by SwiftUI at load time.
    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        webView?.removeFromSuperview()

        let host = PlatformHostingController(rootView: OnboardingView())
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)

        // The storyboard window draws its content full-size, under the title bar,
        // which is right for the web view this replaced but clips the heading of
        // a normal layout. The safe area is where the title bar ends.
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: safe.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: safe.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
        ])
#if os(iOS)
        host.didMove(toParent: self)
#elseif os(macOS)
        // The template window is sized for a small web view; the onboarding
        // needs room for two pickers and the status row without scrolling.
        preferredContentSize = NSSize(width: 520, height: 560)
#endif
    }
}

// MARK: - Onboarding

#if os(macOS)
private let didBecomeActive = NotificationCenter.default
    .publisher(for: NSApplication.didBecomeActiveNotification)
#else
private let didBecomeActive = NotificationCenter.default
    .publisher(for: UIApplication.didBecomeActiveNotification)
#endif

private func code(_ language: Locale.Language) -> String {
    language.languageCode?.identifier ?? language.minimalIdentifier
}

private func name(_ language: Locale.Language) -> String {
    Locale.current.localizedString(forLanguageCode: code(language)) ?? code(language)
}

/// The pair is chosen explicitly here rather than inferred, because the
/// extension's target language is a separate setting living in the extension's
/// own storage, which this app cannot read. Explicit pickers mean the user can
/// always fetch exactly the pair they configured over there.
struct OnboardingView: View {
    @State private var languages: [Locale.Language] = []
    @State private var source = Locale.Language(identifier: "en")
    @State private var target = Locale.Language(identifier: "ko")
    @State private var status: LanguageAvailability.Status?
    @State private var configuration: TranslationSession.Configuration?
    @State private var downloading = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                enableSection
                packSection
            }
            .padding(24)
            .frame(maxWidth: 520, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { await loadLanguages() }
        .translationTask(configuration) { session in
            // prepareTranslation() returns as soon as the system sheet is
            // dismissed, which can happen before the download finishes — the
            // status re-read below is what actually decides readiness.
            try? await session.prepareTranslation()
            await refreshStatus()
            downloading = false
        }
        .onReceive(didBecomeActive) { _ in
            Task { await refreshStatus() }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("QuickGlot").font(.largeTitle.bold())
            Text("Select text in Safari and it is translated on device.")
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var enableSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("1. Turn on the extension").font(.headline)
#if os(macOS)
            Button("Open Safari Extension Settings") {
                SFSafariApplication.showPreferencesForExtension(
                    withIdentifier: extensionBundleIdentifier
                ) { _ in }
            }
#else
            Text("Settings › Apps › Safari › Extensions › QuickGlot, then allow it on the sites you want.")
                .foregroundStyle(.secondary)
#endif
            Text("Pick the language to translate into from the extension's toolbar button.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private var packSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("2. Download a language pair").font(.headline)
            Text("Downloaded once, then it works offline.")
                .font(.callout)
                .foregroundStyle(.secondary)

            if languages.isEmpty {
                ProgressView().padding(.vertical, 8)
            } else {
                Picker("From", selection: $source) {
                    ForEach(languages, id: \.self) { Text(name($0)).tag($0) }
                }
                Picker("To", selection: $target) {
                    ForEach(languages, id: \.self) { Text(name($0)).tag($0) }
                }
                statusRow
            }
        }
        .onChange(of: source) { Task { await refreshStatus() } }
        .onChange(of: target) { Task { await refreshStatus() } }
    }

    @ViewBuilder
    private var statusRow: some View {
        HStack {
            switch status {
            case .installed:
                Label("Ready", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            case .supported:
                if downloading {
                    ProgressView().controlSize(.small)
                } else {
                    Button("Download") { download() }
                }
            case .unsupported:
                Text("This pair is not supported on device.")
                    .foregroundStyle(.secondary)
            case nil:
                ProgressView().controlSize(.small)
            case .some:
                Text("—").foregroundStyle(.secondary)
            }
            Spacer()
            Button("Recheck") { Task { await refreshStatus() } }
                .buttonStyle(.borderless)
        }
        .padding(.top, 4)
    }

    private func download() {
        downloading = true
        // translationTask only re-fires when the configuration compares unequal,
        // so a retry of the same pair has to invalidate() rather than reassign —
        // otherwise the row spins forever.
        if configuration?.source == source, configuration?.target == target {
            configuration?.invalidate()
        } else {
            configuration = TranslationSession.Configuration(source: source, target: target)
        }
    }

    private func loadLanguages() async {
        var seen = Set<String>()
        var found: [Locale.Language] = []
        for language in await LanguageAvailability().supportedLanguages {
            guard seen.insert(code(language)).inserted else { continue }
            found.append(Locale.Language(identifier: code(language)))
        }
        languages = found.sorted { name($0) < name($1) }

        // Default to the pair the user most likely wants: their reading language
        // into the first system language that differs from it.
        if let english = languages.first(where: { code($0) == "en" }) { source = english }
        let preferred = Locale.preferredLanguages.map(Locale.Language.init(identifier:))
        if let first = preferred.first(where: { code($0) != code(source) }),
           let match = languages.first(where: { code($0) == code(first) }) {
            target = match
        }
        await refreshStatus()
    }

    private func refreshStatus() async {
        guard code(source) != code(target) else {
            status = .unsupported
            return
        }
        status = await LanguageAvailability().status(from: source, to: target)
    }
}
