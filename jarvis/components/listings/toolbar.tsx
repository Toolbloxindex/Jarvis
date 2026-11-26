"use client";

import { Menu } from "@base-ui/react/menu";
import { Switch } from "@base-ui/react/switch";
import { CaretDownIcon, CheckIcon, MapTrifoldIcon, SlidersHorizontalIcon } from "@phosphor-icons/react";
import { useId } from "react";
import { cn } from "@/lib/cn";
import { SORT_LABELS, type SortKey } from "@/lib/listings/query";

export function SortMenu({ value, onChange }: { value: SortKey; onChange: (s: SortKey) => void }) {
  return (
    <Menu.Root>
      <Menu.Trigger className="press flex h-10 items-center gap-1.5 rounded-full px-3 text-[14px] font-semibold transition-colors duration-150 hover:bg-hover data-[popup-open]:bg-hover">
        <span className="hidden font-normal text-ink-2 sm:inline">Sort:</span> {SORT_LABELS[value]}
        <CaretDownIcon size={12} weight="bold" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="z-50 outline-none">
          <Menu.Popup
            className={cn(
              "hw-float-menu min-w-[220px] origin-[var(--transform-origin)] rounded-2xl bg-white p-1.5 shadow-[var(--shadow-sheet)] outline-none",
              "transition-[scale,opacity] duration-150 ease-[var(--ease-out)]",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            )}
          >
            <Menu.RadioGroup value={value} onValueChange={(v) => onChange(v as SortKey)}>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                <Menu.RadioItem
                  key={key}
                  value={key}
                  className="flex h-10 cursor-default items-center justify-between gap-6 rounded-xl px-3 text-[14px] outline-none select-none data-[checked]:font-semibold data-[highlighted]:bg-hover"
                >
                  {SORT_LABELS[key]}
                  <Menu.RadioItemIndicator>
                    <CheckIcon size={14} weight="bold" />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Opens or closes the filters side panel (a sheet on small screens). */
export function FiltersTab({
  open,
  count,
  onToggle,
  controls,
}: {
  open: boolean;
  count: number;
  onToggle: () => void;
  controls: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={cn(
        "press flex h-10 shrink-0 items-center gap-2 rounded-full px-4 text-[14px] font-semibold transition-colors duration-150",
        open ? "bg-ink text-white" : "shadow-[inset_0_0_0_1px_var(--color-line)] hover:shadow-[inset_0_0_0_1px_var(--color-ink)]",
      )}
    >
      <SlidersHorizontalIcon size={16} weight="bold" />
      Filters
      {count > 0 && (
        <span
          className={cn(
            "tabular grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px]",
            open ? "bg-white text-ink" : "bg-ink text-white",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export function MapSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className="flex h-10 cursor-pointer items-center gap-2.5 rounded-full pr-1.5 pl-3.5 text-[14px] font-semibold transition-colors duration-150 hover:bg-hover"
    >
      <MapTrifoldIcon size={16} weight="bold" />
      Map
      <Switch.Root
        id={id}
        checked={on}
        onCheckedChange={onChange}
        className="relative flex h-6 w-10 shrink-0 rounded-full bg-line p-0.5 transition-colors duration-200 data-[checked]:bg-ink"
      >
        <Switch.Thumb className="block size-5 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-[translate] duration-200 ease-[var(--ease-out)] data-[checked]:translate-x-4" />
      </Switch.Root>
    </label>
  );
}
