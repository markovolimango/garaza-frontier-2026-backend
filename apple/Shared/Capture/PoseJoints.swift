#if canImport(Vision)
import Vision

/// Explicit Vision joint -> wire name mapping (anatomical left/right as defined by Vision).
public enum PoseJoints {
    public static let names2D: [(VNHumanBodyPoseObservation.JointName, String)] = [
        (.nose, "nose"), (.leftEye, "left_eye"), (.rightEye, "right_eye"), (.leftEar, "left_ear"),
        (.rightEar, "right_ear"), (.neck, "neck"), (.leftShoulder, "left_shoulder"),
        (.rightShoulder, "right_shoulder"), (.leftElbow, "left_elbow"), (.rightElbow, "right_elbow"),
        (.leftWrist, "left_wrist"), (.rightWrist, "right_wrist"), (.leftHip, "left_hip"), (.rightHip, "right_hip"),
        (.leftKnee, "left_knee"), (.rightKnee, "right_knee"), (.leftAnkle, "left_ankle"),
        (.rightAnkle, "right_ankle"), (.root, "root"),
    ]

    public static let names3D: [(VNHumanBodyPose3DObservation.JointName, String)] = [
        (.root, "root"), (.leftHip, "left_hip"), (.leftKnee, "left_knee"), (.leftAnkle, "left_ankle"),
        (.rightHip, "right_hip"), (.rightKnee, "right_knee"), (.rightAnkle, "right_ankle"), (.spine, "spine"),
        (.centerShoulder, "center_shoulder"), (.centerHead, "center_head"), (.topHead, "top_head"),
        (.leftShoulder, "left_shoulder"), (.leftElbow, "left_elbow"), (.leftWrist, "left_wrist"),
        (.rightShoulder, "right_shoulder"), (.rightElbow, "right_elbow"), (.rightWrist, "right_wrist"),
    ]

    static let lookup3D: [VNHumanBodyPose3DObservation.JointName: String] =
        Dictionary(uniqueKeysWithValues: names3D.map { ($0.0, $0.1) })

    /// Vision normalized points use a lower-left origin; the wire uses top-left.
    public static func topLeft(x: Double, y: Double) -> (x: Double, y: Double) { (x, 1.0 - y) }

    /// Wire bound for `image_point` (services/coach `Point2D`: each coordinate in [-10, 10]).
    public static let imagePointBound = 10.0

    /// A 3D joint's `pointInImage` (lower-left origin) as a top-left wire point, or nil when it is unusable.
    /// pointInImage is a perspective projection of Vision's 3D model: joints it extrapolates outside the frame
    /// (legs below a desk or out of shot) can land near or behind the camera plane, giving huge or sign-flipped
    /// values. One such value would make the coach reject the whole pose frame, so the point is omitted instead.
    public static func imagePoint(x: Double, y: Double) -> (x: Double, y: Double)? {
        let p = topLeft(x: x, y: y)
        guard p.x.isFinite, p.y.isFinite, abs(p.x) <= imagePointBound, abs(p.y) <= imagePointBound else { return nil }
        return p
    }
}
#endif
