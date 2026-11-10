import { Bluetooth, Ear, Headphones, Usb, Volume2 } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useState } from "react";
import {
  activeCall,
  type CallOutputKind,
  type CallOutputs,
  nextCallOutput,
  subscribeActiveCall,
} from "../webrtcCall";

const OUTPUTS: Record<CallOutputKind, { label: string; icon: typeof Volume2 }> =
  {
    speaker: { label: "Speaker", icon: Volume2 },
    earpiece: { label: "Earpiece", icon: Ear },
    bluetooth: { label: "Bluetooth", icon: Bluetooth },
    wired: { label: "Headset", icon: Headphones },
    usb: { label: "USB", icon: Usb },
  };

const NONE: CallOutputs = { choices: [], current: null };

/** Where the call plays and what else it could, kept up to date. */
function useCallOutputs(): CallOutputs {
  const [outputs, setOutputs] = useState<CallOutputs>(NONE);
  useEffect(() => {
    let current = 0;
    const read = () => {
      const asked = ++current;
      const call = activeCall();
      if (!call) return setOutputs(NONE);
      void call.outputs().then((next) => {
        if (asked === current) setOutputs(next);
      });
    };
    read();
    const stop = subscribeActiveCall(read);
    const devices = globalThis.navigator?.mediaDevices;
    devices?.addEventListener?.("devicechange", read);
    return () => {
      current += 1;
      stop();
      devices?.removeEventListener?.("devicechange", read);
    };
  }, []);
  return outputs;
}

/**
 * The call's output on a phone: a tap moves it to the next one (the
 * loudspeaker, the earpiece, a headset). The loudspeaker plays the
 * replies as media, the others as a phone call (webrtcCall.ts's modes):
 * moving between them pauses the replies a few seconds. Shown only when
 * the browser offers a choice, which Chrome on Android does.
 */
export function CallOutputButton({
  className,
  withLabel = false,
  onMouseDown,
}: {
  className: string;
  withLabel?: boolean;
  onMouseDown?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const outputs = useCallOutputs();
  const [moving, setMoving] = useState(false);
  const next = nextCallOutput(outputs);
  if (!next || !outputs.current) return null;
  const busy = moving || activeCall()?.isSwitching() === true;
  const now = OUTPUTS[outputs.current];
  const Icon = now.icon;
  return (
    <button
      type="button"
      className={className}
      aria-label={`Plays on the ${now.label.toLowerCase()}: move to the ${OUTPUTS[next.kind].label.toLowerCase()}`}
      title={`On the ${now.label.toLowerCase()}: tap for the ${OUTPUTS[next.kind].label.toLowerCase()}`}
      disabled={busy}
      onMouseDown={onMouseDown}
      onClick={() => {
        const call = activeCall();
        if (!call) return;
        setMoving(true);
        void call.useOutput(next).finally(() => setMoving(false));
      }}
    >
      <Icon size={withLabel ? 15 : 18} aria-hidden="true" />
      {withLabel ? now.label : null}
    </button>
  );
}
