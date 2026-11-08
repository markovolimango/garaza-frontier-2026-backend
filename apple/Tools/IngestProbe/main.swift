// ingest-probe: exercises the Swift transport (pairing, Authorization header, clock handshake, join,
// re-join, batching, acks) against a running backend, sending Vision pose results computed from a
// still image. The data is marked simulated (a photo is not a live camera session).
//   swift run ingest-probe --url http://127.0.0.1:8765 --code 12345678 --session ses_... --image photo.jpg
//   --wait-session S   seconds to wait for a session (default 5); start the probe before creating one
//   --sessions N       send to N consecutive sessions (end one, create the next: the probe re-joins)
import CoachCapture
import CoachTransport
import CoachWire
import Foundation
import ImageIO

var url = "http://127.0.0.1:8765", code = "", sessionId: String?, imagePath = "", frames = 20
var waitSession = 5.0, sessionsWanted = 1
var args = CommandLine.arguments.dropFirst()
while let arg = args.popFirst() {
    switch arg {
    case "--url": url = args.popFirst() ?? url
    case "--code": code = args.popFirst() ?? ""
    case "--session": sessionId = args.popFirst()
    case "--image": imagePath = args.popFirst() ?? ""
    case "--frames": frames = Int(args.popFirst() ?? "20") ?? 20
    case "--wait-session": waitSession = Double(args.popFirst() ?? "5") ?? 5
    case "--sessions": sessionsWanted = max(1, Int(args.popFirst() ?? "1") ?? 1)
    default: break
    }
}
guard let base = URL(string: url), !code.isEmpty,
      let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: imagePath) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    print("usage: ingest-probe --url URL --code PAIRING_CODE [--session ID] --image PATH [--frames N] "
          + "[--wait-session S] [--sessions N]")
    exit(2)
}

let deviceId = "probe-" + UUID().uuidString.lowercased().prefix(8)
let semaphore = DispatchSemaphore(value: 0)
Task {
    do {
        let paired = try await Pairing.pair(baseURL: base, code: code, deviceId: deviceId, kind: "simulator", name: "ingest-probe")
        let connection = CoachConnection(config: .init(baseURL: base, token: paired.deviceToken, deviceId: deviceId,
                                                       kind: "simulator", sessionId: sessionId))
        await connection.start()
        let sourceInfo = SourceInfo(deviceId: deviceId, kind: "mac", simulated: true)
        let estimator = PoseEstimator(preference: .prefer3D)
        let input = PoseEstimator.Input(cgImage: image, width: image.width, height: image.height)
        var previous: String?
        for _ in 0..<sessionsWanted {
            var joined: SessionControl?
            let deadline = Date().addingTimeInterval(waitSession)
            while Date() < deadline {
                if let current = await connection.session, current.state != "ended", current.sessionId != previous {
                    joined = current
                    break
                }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            guard let session = joined else {
                print("no session joined within \(waitSession) s: \(await connection.stats)")
                exit(1)
            }
            print("joined \(session.sessionId) (\(session.state))")
            await connection.enqueue(OutgoingEvent(sessionId: session.sessionId, source: sourceInfo, eventType: .deviceStatus,
                                                   capturedAt: Date(), payload: .deviceStatus(DeviceStatusPayload(status: "online",
                                                   reason: "ingest-probe (still image)"))))
            for _ in 0..<frames {
                let payload = estimator.process(input, live: false)
                await connection.enqueue(OutgoingEvent(sessionId: session.sessionId, source: sourceInfo, eventType: .poseFrame,
                                                       capturedAt: Date(), payload: .pose(payload)))
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            try await Task.sleep(nanoseconds: 1_500_000_000)
            previous = session.sessionId
        }
        let stats = await connection.stats
        print("sessions=\(sessionsWanted) state=\(stats.state) sent=\(stats.sent) accepted=\(stats.accepted) " +
              "duplicates=\(stats.duplicates) rejected=\(stats.rejected) retried=\(stats.retried) " +
              "droppedPose=\(stats.droppedPose) droppedOversize=\(stats.droppedOversize) " +
              String(format: "clock offset=%.2f ms ± %.2f ms", stats.clockOffsetMs ?? .nan, stats.clockUncertaintyMs ?? .nan) +
              (stats.lastRejection.map { " lastRejection=\($0)" } ?? ""))
        await connection.stop()
        exit(stats.rejected == 0 && stats.accepted > 0 ? 0 : 1)
    } catch {
        print("ingest-probe failed: \(error.localizedDescription)")
        exit(1)
    }
}
semaphore.wait()
