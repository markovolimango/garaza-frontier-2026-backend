// vision-probe: run the CoachCapture Vision pose adapter on still images on this Mac.
//   swift run vision-probe <image>... [--mode auto|2d|3d] [--repeat 5] [--json]
// Verifies the real Vision APIs (3D request, 2D fallback, joint mapping, timings). It does not
// exercise the iPhone camera or the iPhone's hardware.
import CoachCapture
import CoachWire
import Foundation
import ImageIO

var paths: [String] = []
var mode = PoseEstimator.Preference.prefer3D
var repeats = 5
var emitJSON = false
var args = CommandLine.arguments.dropFirst()
while let arg = args.popFirst() {
    switch arg {
    case "--mode": mode = PoseEstimator.Preference(rawValue: args.popFirst() ?? "auto") ?? .prefer3D
    case "--repeat": repeats = max(1, Int(args.popFirst() ?? "5") ?? 5)
    case "--json": emitJSON = true
    default: paths.append(arg)
    }
}
guard !paths.isEmpty else {
    FileHandle.standardError.write(Data("usage: vision-probe <image>... [--mode auto|2d|3d] [--repeat N] [--json]\n".utf8))
    exit(2)
}

for path in paths {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        FileHandle.standardError.write(Data("cannot read \(path)\n".utf8))
        continue
    }
    let estimator = PoseEstimator(preference: mode)
    let input = PoseEstimator.Input(cgImage: image, width: image.width, height: image.height, cameraPosition: "unspecified")
    var times: [Double] = []
    var payload = estimator.process(input, live: false)
    times.append(payload.inferenceMs ?? 0)
    for _ in 1..<repeats {
        payload = estimator.process(input, live: false)
        times.append(payload.inferenceMs ?? 0)
    }
    if emitJSON {
        let data = try WireCoding.makeEncoder().encode(payload)
        print(String(decoding: data, as: UTF8.self))
        continue
    }
    let sorted = times.dropFirst().sorted()
    let median = sorted.isEmpty ? times[0] : sorted[sorted.count / 2]
    print("\(URL(fileURLWithPath: path).lastPathComponent): mode=\(payload.mode) detector=\(payload.detector) rev=\(payload.detectorRevision ?? -1) " +
          "persons=\(payload.personsDetected) joints2D=\(payload.joints2D?.count ?? 0) joints3D=\(payload.joints3D?.count ?? 0) " +
          String(format: "first=%.1f ms median(after first)=%.1f ms", times[0], median))
    if let fallback = estimator.fallbackReason { print("  fallback: \(fallback)") }
    if let joints = payload.joints3D, !joints.isEmpty {
        func p(_ n: String) -> [Double]? { joints.first { $0.name == n }?.positionM }
        print(String(format: "  bodyHeight=%.2f m (%@), observation confidence=%@", payload.bodyHeightM ?? 0,
                     payload.heightEstimation ?? "-", payload.observationConfidence.map { String(format: "%.3f", $0) } ?? "nil"))
        for name in ["root", "top_head", "left_shoulder", "right_shoulder", "left_wrist", "right_wrist"] {
            if let v = p(name) { print(String(format: "  %-15@ position_m = [%+.3f, %+.3f, %+.3f]", name as NSString, v[0], v[1], v[2])) }
        }
        if let root = payload.rootCameraPositionM {
            print(String(format: "  root camera-relative position = [%+.3f, %+.3f, %+.3f] m", root[0], root[1], root[2]))
        }
        let parents = joints.compactMap { j in j.parent.map { "\(j.name)<-\($0)" } }.prefix(6).joined(separator: ", ")
        print("  parents: \(parents)")
    }
    if let joints = payload.joints2D, !joints.isEmpty {
        let sample = joints.prefix(4).map { String(format: "%@(%.2f,%.2f c=%.2f)", $0.name, $0.x, $0.y, $0.confidence) }
        print("  2D: " + sample.joined(separator: " "))
    }
}
