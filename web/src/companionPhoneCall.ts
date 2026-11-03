import { companionCallState, subscribeCompanionCall } from "./companionCall";

/**
 * On a phone, a call with the companion is its whole conversation view
 * (CompanionPanel), not the thin strip and chip: each start shows it, and
 * the call's end takes it away again when the call showed it. A view the
 * user had open before the call stays after it. The function that stops
 * watching back.
 */
export function showCompanionCallOnPhone({
  phone,
  shown,
  show,
  hide,
}: {
  phone: () => boolean;
  shown: () => boolean;
  show: () => void;
  hide: () => void;
}): () => void {
  let started = companionCallState().started;
  let open = companionCallState().open;
  let showedIt = false;
  return subscribeCompanionCall(() => {
    const call = companionCallState();
    if (call.open && call.started !== started) {
      started = call.started;
      if (phone() && !shown()) {
        show();
        showedIt = true;
      }
    } else if (!call.open && open) {
      if (showedIt && shown()) hide();
      showedIt = false;
    }
    open = call.open;
  });
}
