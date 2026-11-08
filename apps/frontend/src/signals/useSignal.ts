import { useEffect, useState } from "react";
import { getLast, subscribe, type Channel, type Channels } from "./bus";

export function useSignal<C extends Channel>(channel: C): Channels[C] | undefined {
  const [value, setValue] = useState<Channels[C] | undefined>(undefined);
  useEffect(() => {
    setValue(getLast(channel));
    return subscribe(channel, setValue);
  }, [channel]);
  return value;
}
