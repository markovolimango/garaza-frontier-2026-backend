// watchOS sensor app (needs Xcode with the watchOS SDK; not compiled by scripts/apple-check.sh).
// Minimal controls only: authorization, collection mode, explicit workout start/stop and save/discard.
import SwiftUI

@main
struct WatchSensorsApp: App {
    @StateObject private var model = WatchModel()
    var body: some Scene {
        WindowGroup { WatchControlsView(model: model) }
    }
}

struct WatchControlsView: View {
    @ObservedObject var model: WatchModel

    var body: some View {
        List {
            Section("Health access") {
                Button("Allow heart rate") { Task { await model.authorize(includeHRV: false) } }
                Text(model.authorizationText).font(.footnote)
            }
            Section("Collection") {
                Button(model.passiveRunning ? "Stop passive samples" : "Passive samples (best effort)") {
                    model.passiveRunning ? model.stopPassive() : model.startPassive()
                }
                Text("Passive: watchOS decides when heart rate is measured; samples can be minutes apart.")
                    .font(.footnote)
            }
            Section("Workout (explicit)") {
                Picker("Activity", selection: $model.activity) {
                    ForEach(WatchModel.Activity.allCases) { Text($0.label).tag($0) }
                }
                if model.workoutState == "running" {
                    Button("Stop workout") { model.stopWorkout() }
                } else if model.workoutState == "stopped" {
                    Button("Save workout to Health") { model.finishWorkout(save: true) }
                    Button("Discard workout", role: .destructive) { model.finishWorkout(save: false) }
                } else {
                    Button("Start workout") { Task { await model.startWorkout() } }
                }
                Text("Records a workout in Health. Start it only when the activity really is a workout.")
                    .font(.footnote)
            }
            Section("Status") {
                Text("iPhone reachable: \(model.reachable ? "yes" : "no")")
                if let bpm = model.lastBPM { Text("Last: \(Int(bpm)) bpm, \(Int(model.lastAge)) s ago") }
                if let error = model.error { Text(error).font(.footnote) }
            }
        }
    }
}
