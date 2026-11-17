import type * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "../../utils";
import "./popover.css";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverContent = ({
  className,
  align = "start",
  sideOffset = 8,
  container,
  ...props
}: React.ComponentPropsWithRef<typeof PopoverPrimitive.Content> & {
  /** Where the portal goes; the document's body by default. */
  container?: HTMLElement | null;
}) => (
  <PopoverPrimitive.Portal container={container}>
    <div className="popover-portal">
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn("popover-content", className)}
        {...props}
      />
    </div>
  </PopoverPrimitive.Portal>
);
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverContent, PopoverTrigger };
