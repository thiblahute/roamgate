import {
  Bluetooth,
  Ear,
  Headphones,
  Smartphone,
  Usb,
  Volume2,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useState } from "react";
import {
  activeCall,
  type CallOutputKind,
  type CallOutputs,
  nextCallOutput,
  subscribeActiveCall,
  type WebRtcCall,
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
 * Whether the phone keeps the call's microphone from it now (the screen
 * off, another app in front): the call shows MICROPHONE_PAUSED meanwhile.
 */
export function useMicrophonePausedByPhone(): boolean {
  const [paused, setPaused] = useState(
    () => activeCall()?.microphonePausedByPhone() != null,
  );
  useEffect(() => {
    const read = () =>
      setPaused(activeCall()?.microphonePausedByPhone() != null);
    read();
    return subscribeActiveCall(read);
  }, []);
  return paused;
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

/** Where the call is: in the Roamgate app, being handed to it, or here. */
export type CallPlace = "app" | "opening" | "can" | null;

/**
 * Where `call` is, for its button. In the app's own WebView the call goes
 * to the app by itself, and saying it is in the app tells nothing: no
 * button there.
 */
export function callPlace(
  call: Pick<
    WebRtcCall,
    "inApp" | "inAppWebView" | "handingOff" | "canHandOff"
  > | null,
): CallPlace {
  if (!call || call.inAppWebView()) return null;
  if (call.inApp()) return "app";
  if (call.handingOff()) return "opening";
  return call.canHandOff() ? "can" : null;
}

function useCallPlace(): CallPlace {
  const read = (): CallPlace => callPlace(activeCall());
  const [place, setPlace] = useState<CallPlace>(read);
  useEffect(() => {
    const update = () => setPlace(read());
    update();
    return subscribeActiveCall(update);
  }, []);
  return place;
}

/**
 * The call and the Roamgate Android app (webrtcCall.ts's handOff): "In
 * the Roamgate app" while the app carries it (hang-up and the output
 * button still work from here), or a button handing it to the app on a
 * phone that has it, when it did not take it by itself. Nothing
 * elsewhere.
 */
export function CallAppButton({
  className,
  withLabel = false,
  onMouseDown,
}: {
  className: string;
  withLabel?: boolean;
  onMouseDown?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const place = useCallPlace();
  if (!place) return null;
  const label =
    place === "app"
      ? "In the Roamgate app"
      : place === "opening"
        ? "Opening the Roamgate app"
        : "Move to the Roamgate app";
  return (
    <button
      type="button"
      className={className}
      aria-label={
        place === "can"
          ? "Move the call to the Roamgate app, which keeps the microphone with the screen off"
          : label
      }
      title={label}
      disabled={place !== "can"}
      aria-pressed={place === "app"}
      onMouseDown={onMouseDown}
      onClick={() => activeCall()?.handOff()}
    >
      <Smartphone size={withLabel ? 15 : 18} aria-hidden="true" />
      {withLabel ? label : null}
    </button>
  );
}
