#if canImport(SwiftUI)
import SwiftUI

/// Minimal, unstyled controls: endpoint, pairing, permissions, connection, capture and diagnostics.
/// Not a product UI (no dashboards or charts); a separate frontend uses the backend APIs.
public struct CaptureControlsView: View {
    @ObservedObject var controller: CaptureController
    @State private var connected = false

    public init(controller: CaptureController) { self.controller = controller }

    public var body: some View {
        Form {
            Section("Backend") {
                TextField("https://<mac>.local:8765", text: $controller.endpoint)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    #endif
                HStack {
                    TextField("Pairing code", text: $controller.pairingCode)
                    Button("Pair") { Task { await controller.pair() } }
                        .disabled(controller.pairingCode.count < 8)
                }
                Toggle("Connected", isOn: $connected)
                    .onChange(of: connected) { _, on in on ? controller.connect() : controller.disconnect() }
                    .disabled(!controller.paired)
                Text("Status: \(controller.stats.state)")
                if let error = controller.stats.lastError { Text(error).font(.footnote) }
                if let message = controller.message { Text(message).font(.footnote) }
            }
            Section("Permissions") {
                Button("Request camera, microphone and speech access") { Task { await controller.requestPermissions() } }
                Text("Speech: \(controller.speechStatus)").font(.footnote)
            }
            Section("Capture") {
                Picker("Pose", selection: $controller.posePreference) {
                    Text("3D, 2D fallback").tag("auto")
                    Text("2D only").tag("2d")
                    Text("3D only").tag("3d")
                }
                Stepper("Pose rate \(Int(controller.poseRateHz)) Hz", value: $controller.poseRateHz, in: 1...30)
                TextField("Language (e.g. en-US, sr-RS)", text: $controller.language)
                    .onSubmit { controller.refreshSpeechStatus() }
                Toggle("Microphone + transcription", isOn: $controller.speechEnabled)
                Button(controller.capturing ? "Stop capture" : "Start capture") {
                    controller.capturing ? controller.stopCapture() : controller.startCapture()
                }
                Text("Session: \(controller.stats.sessionId ?? "none") (\(controller.stats.sessionState ?? "-"))")
                Text("Pose mode: \(controller.poseMode)" + (controller.lastInferenceMs.map { String(format: ", %.1f ms", $0) } ?? ""))
                if let fallback = controller.poseFallback { Text(fallback).font(.footnote) }
            }
            Section("Apple Watch") {
                Text("Paired \(controller.watchStatus.paired ? "yes" : "no"), reachable \(controller.watchStatus.reachable ? "yes" : "no"), mode \(controller.watchStatus.collectionMode)")
                if let age = controller.watchStatus.lastSampleAge { Text(String(format: "Last sample %.0f s old", age)) }
            }
            Section("Diagnostics") {
                let s = controller.stats
                Text("Sent \(s.sent), accepted \(s.accepted), duplicates \(s.duplicates), rejected \(s.rejected)")
                Text("Dropped pose \(s.droppedPose), dropped high \(s.droppedHigh), pending \(s.pendingHigh), reconnects \(s.reconnects)")
                Text("Retried \(s.retried), dropped oversize \(s.droppedOversize), unencodable \(s.droppedUnencodable)")
                Text("Backpressure \(s.backpressure ? "on" : "off")" + (s.clockOffsetMs.map {
                    String(format: ", clock offset %.1f ± %.1f ms", $0, s.clockUncertaintyMs ?? 0) } ?? ""))
                if let rejection = s.lastRejection { Text(rejection).font(.footnote) }
                Text("Device id \(controller.deviceId)").font(.footnote)
            }
        }
    }
}
#endif
