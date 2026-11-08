/**
 * Minimal light-grey room: flat-shaded matte blocks, no emissives (stylized "clean geometry" look).
 * Keep props referentially stable (strings/numbers, no per-render objects): the dev-only TanStack
 * inject-source plugin adds `data-tsd-source` to JSX, and R3F throws on it during prop updates.
 */
import { memo } from "react";
import type { JudgeConfig } from "./types";

const W = 9; // room width
const H = 3.4; // ceiling height
const BACK = -5.2;
const FRONT = 4.6;
const DEPTH = FRONT - BACK;
const MID_Z = (FRONT + BACK) / 2;

const FLOOR = "#d9dadc";
const WALL = "#eceded";
const CEIL = "#f4f4f5";
const TABLE = "#c4c6c9";
const TABLE_BODY = "#b2b4b8";
const CHAIR = "#b3b5b9";
const CHAIR_DARK = "#8e9196";

function Block({ size, position, color, cast = true }: { size: [number, number, number]; position: [number, number, number]; color: string; cast?: boolean }) {
  return (
    <mesh position={position} castShadow={cast} receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={1} metalness={0} flatShading />
    </mesh>
  );
}

function Shell() {
  return (
    <group>
      <Block size={[W, 0.1, DEPTH]} position={[0, -0.05, MID_Z]} color={FLOOR} cast={false} />
      <Block size={[W, H, 0.1]} position={[0, H / 2, BACK - 0.05]} color={WALL} cast={false} />
      <Block size={[0.1, H, DEPTH]} position={[-W / 2 - 0.05, H / 2, MID_Z]} color={WALL} cast={false} />
      <Block size={[0.1, H, DEPTH]} position={[W / 2 + 0.05, H / 2, MID_Z]} color={WALL} cast={false} />
      <Block size={[W, 0.1, DEPTH]} position={[0, H + 0.05, MID_Z]} color={CEIL} cast={false} />
      {/* a few plain columns and a lintel to give the back wall some structure */}
      {[-3.3, -1.1, 1.1, 3.3].map((x) => (
        <Block key={x} size={[0.36, H, 0.24]} position={[x, H / 2, BACK + 0.12]} color={WALL} cast={false} />
      ))}
      <Block size={[W, 0.3, 0.3]} position={[0, H - 0.15, BACK + 0.15]} color={WALL} cast={false} />
    </group>
  );
}

function Table() {
  return (
    <group>
      {/* two stacked blocks: an overhanging top and a recessed, slightly darker body */}
      <Block size={[5.0, 0.1, 1.0]} position={[0, 0.73, 0]} color={TABLE} />
      <Block size={[4.6, 0.68, 0.72]} position={[0, 0.34, -0.06]} color={TABLE_BODY} />
    </group>
  );
}

function Chair({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <Block size={[0.5, 0.07, 0.5]} position={[0, 0.46, 0]} color={CHAIR} />
      <Block size={[0.5, 0.6, 0.06]} position={[0, 0.8, -0.24]} color={CHAIR} />
      {[-0.21, 0.21].map((dx) =>
        [-0.21, 0.21].map((dz) => <Block key={`${dx}${dz}`} size={[0.04, 0.43, 0.04]} position={[dx, 0.215, dz]} color={CHAIR_DARK} />),
      )}
    </group>
  );
}

export const Room = memo(function Room({ judges }: { judges: JudgeConfig[] }) {
  return (
    <group>
      <Shell />
      <Table />
      {judges.map((j, i) => (
        <Chair key={i} x={j.position[0]} z={j.position[2] - 0.1} />
      ))}
    </group>
  );
});
