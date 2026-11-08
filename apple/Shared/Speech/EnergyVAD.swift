import CoachWire
import Foundation

/// Energy-threshold voice activity detection. This is a HEURISTIC: any sound louder than the
/// calibrated noise floor (other voices, music, the synthesizer) counts as speech.
///
/// 1. Calibration: the first `calibrationSeconds` of audio set the noise floor (20th percentile).
/// 2. Threshold = noise floor + margin, clamped to [minThresholdDb, maxThresholdDb].
/// 3. Hysteresis: speech starts after `startHoldSeconds` above the threshold (backdated to the
///    start of that run); it ends after `endHangoverSeconds` below threshold - 3 dB (backdated).
/// Transition times are audio times, never recognizer callback times.
public struct EnergyVAD: Sendable {
    public struct Config: Sendable {
        public var calibrationSeconds = 1.5
        public var marginDb: Float = 10
        public var minThresholdDb: Float = -55
        public var maxThresholdDb: Float = -20
        public var startHoldSeconds = 0.15
        public var endHangoverSeconds = 0.45
        public var releaseDb: Float = 3
        public init() {}
    }

    public static let method = "energy_threshold_heuristic_v1"
    public let config: Config
    public private(set) var noiseFloorDb: Float?
    public private(set) var thresholdDb: Float?
    public private(set) var isSpeech = false
    private var calibration: [Float] = []
    private var calibrationElapsed = 0.0
    private var runStart: Date?
    private var runDuration = 0.0

    public init(config: Config = Config()) { self.config = config }

    public var calibrated: Bool { thresholdDb != nil }

    /// RMS level of float samples in dBFS, clamped to [-100, 0]. Float audio can exceed full scale
    /// (RMS > 1); the wire contract requires level_dbfs <= 0. NaN samples read as silence.
    public static func levelDbfs(_ samples: UnsafeBufferPointer<Float>) -> Float {
        guard !samples.isEmpty else { return -100 }
        var sum: Float = 0
        for s in samples { sum += s * s }
        let rms = (sum / Float(samples.count)).squareRoot()
        guard rms.isFinite else { return rms.isNaN ? -100 : 0 }
        return min(0, max(-100, 20 * log10(max(rms, 1e-10))))
    }

    /// Feed one buffer's level. `time` is the wall time of the buffer start, `duration` its length.
    public mutating func process(levelDb: Float, duration: Double, at time: Date) -> [(SpeechActivityPayload, Date)] {
        guard let threshold = thresholdDb else {
            calibration.append(levelDb)
            calibrationElapsed += duration
            if calibrationElapsed >= config.calibrationSeconds {
                let sorted = calibration.sorted()
                let floor = sorted[Int(Double(sorted.count - 1) * 0.2)]
                noiseFloorDb = floor
                thresholdDb = min(config.maxThresholdDb, max(config.minThresholdDb, floor + config.marginDb))
            }
            return []
        }
        let wantSpeech = isSpeech ? levelDb >= threshold - config.releaseDb : levelDb >= threshold
        if wantSpeech == isSpeech {
            runStart = nil
            runDuration = 0
            return []
        }
        if runStart == nil { runStart = time }
        runDuration += duration
        let needed = isSpeech ? config.endHangoverSeconds : config.startHoldSeconds
        guard runDuration >= needed, let start = runStart else { return [] }
        isSpeech.toggle()
        runStart = nil
        runDuration = 0
        let payload = SpeechActivityPayload(transition: isSpeech ? "speech_start" : "speech_end", vadMethod: Self.method,
                                            levelDbfs: Double(min(0, levelDb)), thresholdDbfs: Double(min(0, threshold)),
                                            noiseFloorDbfs: noiseFloorDb.map { Double(min(0, $0)) }, calibrated: true)
        return [(payload, start)]   // backdated to when the qualifying run began
    }
}
