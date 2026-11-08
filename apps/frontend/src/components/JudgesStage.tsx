import { useEffect, useMemo, useRef, useState } from "react";
import { Volume2 } from "lucide-react";
import { JudgesScene, readLiveParams, seatedJudges, useJudgesLive, type JudgesHandle } from "@/judges";
import { Button } from "@/components/ui/button";
import { NextButton } from "@/components/NextButton";
import { getLast, publish, subscribe } from "@/signals";
import { judgesMode } from "@/signals/judges";

export function JudgesStage() {
  const judges = useRef<JudgesHandle>(null);
  // brain integration: seat the brain's panel (with nameplates); without a brain, the default four.
  const [panel, setPanel] = useState(() => getLast("judgePanel"));
  useEffect(() => subscribe("judgePanel", setPanel), []);
  const seats = useMemo(() => (panel ? seatedJudges(panel) : undefined), [panel]);
  const [params] = useState(() => ({ ...readLiveParams(), mode: judgesMode(window.location.search) }));
  const live = useJudgesLive(judges, params.mode, params.url);
  const [audioError, setAudioError] = useState(false);
  const sayRef = useRef(live.sayLocal);
  sayRef.current = live.sayLocal;
  const enableRef = useRef(live.enableAudio);
  enableRef.current = live.enableAudio;

  useEffect(() => {
    const unsubscribe = subscribe("judgeCommand", (command) => {
      if (command.type === "say") sayRef.current(command.judge, command.text);
      else if (command.type === "speak") {   // brain integration: judge audio from the brain
        const stop = judges.current?.speak(command.judge, command.text, command.level);
        void command.done.then(() => stop?.());
      }
      else if (command.type === "look") judges.current?.lookAt(command.judge, command.target);   // brain integration
      else judges.current?.react(command.judge, command.reaction);
    });
    publish("judgesReady", true);
    return () => {
      unsubscribe();
      publish("judgesReady", false);
    };
  }, []);

  // brain integration: after any earlier click on the page the browser allows audio, so the judges'
  // voice needs no extra click. Deferred a tick so StrictMode's mount/unmount/mount creates one player.
  useEffect(() => {
    const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
    if (!activation?.hasBeenActive) return;
    const t = setTimeout(() => void enableRef.current().catch(() => {}), 0);
    return () => clearTimeout(t);
  }, []);

  return (
    <main className="fixed inset-0">
      <JudgesScene ref={judges} judges={seats} />
      <div className="absolute left-4 top-4 z-20 flex flex-wrap items-center gap-2">
        {!live.audioOn && (
          <Button variant="outline" onClick={() => {
            setAudioError(false);
            void live.enableAudio().catch(() => setAudioError(true));
          }}>
            <Volume2 /> Enable audio
          </Button>
        )}
        {live.audioOn && <span className="px-1 py-2 text-xs text-muted-foreground">Audio on</span>}
        {audioError && <span role="alert" className="px-1 py-2 text-xs text-muted-foreground">Audio unavailable. Try again.</span>}
      </div>
      <div className="absolute bottom-6 left-4 z-20">
        <NextButton to="/report" label="Report" />
      </div>
    </main>
  );
}