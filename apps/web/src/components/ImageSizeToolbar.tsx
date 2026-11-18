import { Fragment, useState } from "react";
import { IMAGE_ALT_MAX, type TemplateImageSize } from "@dispatch/shared";
import { altFallbackNote, sizeHint, sizeLabel, type ImageEntry } from "../lib/imageSizeControls";

// Templates → Images, under each image row (ENABLE_IMAGE_SIZE_CONTROLS): a Gmail-style toolbar —
// Small | Best fit | Original size | Edit alt text | Remove — with the live size on the right.
// Buttons, so the editor's disabled fieldset (editors: view only) disables them too.

const SIZES: Array<[TemplateImageSize, string]> = [
  ["small", "Small"],
  ["fit", "Best fit"],
  ["original", "Original size"],
];

export function ImageSizeToolbar({
  image,
  index,
  onSize,
  onAlt,
  onRemove,
}: {
  image: ImageEntry;
  index: number;
  onSize: (size: TemplateImageSize) => void;
  onAlt: (alt: string) => void;
  /** Same as the row's X button. */
  onRemove: () => void;
}) {
  const [altOpen, setAltOpen] = useState(() => !!image.alt?.trim());
  const altId = `template-image-alt-${index}`;
  const hint = sizeHint(image);
  const link = "rounded px-1 py-0.5 hover:bg-tint";
  const sep = (
    <span aria-hidden="true" className="text-slate-400">
      |
    </span>
  );

  return (
    <div className="mt-2">
      <div
        role="toolbar"
        aria-label={`Image ${index + 1} size and alt text`}
        className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs"
      >
        {SIZES.map(([value, label]) => {
          const active = image.size === value;
          return (
            <Fragment key={value}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onSize(value)}
                className={`${link} ${active ? "bg-accent-soft font-semibold text-accent-ink" : "text-slate-550 hover:text-ink"}`}
              >
                {label}
              </button>
              {sep}
            </Fragment>
          );
        })}
        <button
          type="button"
          aria-expanded={altOpen}
          aria-controls={altId}
          onClick={() => setAltOpen((open) => !open)}
          className={`${link} text-slate-550 hover:text-ink`}
        >
          Edit alt text
        </button>
        {sep}
        <button type="button" onClick={onRemove} className={`${link} text-slate-550 hover:text-crit`}>
          Remove
        </button>
        <span className="ml-auto text-slate-550" aria-live="polite" data-testid="image-size-label">
          {sizeLabel(image)}
        </span>
      </div>
      {hint && <p className="mt-1 text-xs text-slate-550">{hint}</p>}
      {altOpen && (
        <div id={altId} className="mt-2">
          <label className="label" htmlFor={`${altId}-input`}>
            Alt text
          </label>
          <input
            id={`${altId}-input`}
            className="input text-xs"
            maxLength={IMAGE_ALT_MAX}
            value={image.alt ?? ""}
            placeholder="Describe the image for people who can't see it"
            onChange={(e) => onAlt(e.target.value.slice(0, IMAGE_ALT_MAX))}
          />
          <div className="mt-1 flex justify-between gap-2 text-[11px] text-slate-550">
            <span>{altFallbackNote(image)}</span>
            <span>
              {(image.alt ?? "").length}/{IMAGE_ALT_MAX}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
