import Foundation

/// Exponential backoff (initial, doubling, capped). Call `reset()` after a success.
/// Used for WebSocket reconnects and recognizer restarts.
public struct Backoff: Sendable, Equatable {
    public let initial: Double
    public let maximum: Double
    public let factor: Double
    public private(set) var attempt = 0

    public init(initial: Double = 0.5, maximum: Double = 10, factor: Double = 2) {
        self.initial = initial
        self.maximum = maximum
        self.factor = factor
    }

    /// The delay before the next attempt; each call doubles the following one up to `maximum`.
    public mutating func next() -> Double {
        let delay = min(maximum, initial * pow(factor, Double(attempt)))
        attempt = min(attempt + 1, 64)
        return delay
    }

    public mutating func reset() { attempt = 0 }
}
