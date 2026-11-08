import { useEffect, useRef, useState } from "react";
import { Volume2 } from "lucide-react";
import { JudgesScene, readLiveParams, useJudgesLive, type JudgesHandle } from "@/judges";
import { Button } from "@/components/ui/button";
import { NextButton } from "@/components/NextButton";
import { publish, subscribe } from "@/signals";
import { judgesMode } from "@/signals/judges";

export function JudgesStage() {
  const judges = useRef<JudgesHandle>(null);
  const [params] = useState(() => ({ ...readLiveParams(), mode: judgesMode(window.location.search) }));
  const live = useJudgesLive(judges, params.mode, params.url);
  const [audioError, setAudioError] = useState(false);
  const sayRef = useRef(live.sayLocal);
  sayRef.current = live.sayLocal;

  useEffect(() => {
    const unsubscribe = subscribe("judgeCommand", (command) => {
      if (command.type === "say") sayRef.current(command.judge, command.text);
      else judges.current?.react(command.judge, command.reaction);
    });
    publish("judgesReady", true);
    return () => {
      unsubscribe();
      publish("judgesReady", false);
    };
  }, []);

  return (
    <main className="fixed inset-0">
      <JudgesScene ref={judges} />
      <div className="absolute left-4 top-4 z-20 flex flex-wrap items-center gap-2">
        {!live.audioOn && (
          <Button onClick={() => {
            setAudioError(false);
            void live.enableAudio().catch(() => setAudioError(true));
          }}>
            <Volume2 /> Enable audio
          </Button>
        )}
        {live.audioOn && <span className="rounded-md bg-background/80 px-3 py-2 text-xs text-foreground">Audio on</span>}
        {audioError && <span role="alert" className="rounded-md bg-background/80 px-3 py-2 text-xs text-foreground">Audio unavailable. Try again.</span>}
      </div>
      <div className="absolute bottom-6 left-4 z-20">
        <NextButton to="/report" label="Report" />
      </div>
    </main>
  );
}