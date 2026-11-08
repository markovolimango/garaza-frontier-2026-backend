import Foundation

/// NTP-style offset estimate; identical formula to the backend (coach/clocksync.py).
/// offset = server_time - device_time; uncertainty ~ rtt / 2 of the best sample.
public struct ClockSample: Equatable, Sendable {
    public let offsetMs: Double
    public let rttMs: Double

    public init?(t0: Double, t1: Double, t2: Double, t3: Double) {
        let rtt = (t3 - t0) - (t2 - t1)
        guard rtt >= 0, t2 >= t1, t3 >= t0 else { return nil }
        offsetMs = ((t1 - t0) + (t2 - t3)) / 2
        rttMs = rtt
    }

    public static func best(_ samples: [ClockSample]) -> ClockSample? {
        samples.min { $0.rttMs < $1.rttMs }
    }
}
