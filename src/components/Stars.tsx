import { useState } from "react";
import { Star } from "lucide-react";
import { cn } from "./ui";

interface Props {
  value: number;
  onChange?: (value: number) => void;
  readOnly?: boolean;
}

/** 5-star rating (Rekordbox-style). Click a star to set; click it again to clear. */
export function Stars({ value, onChange, readOnly }: Props) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;

  return (
    <div className="flex items-center gap-0.5" onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          disabled={readOnly}
          onMouseEnter={() => !readOnly && setHover(n)}
          onClick={(e) => {
            e.stopPropagation();
            onChange?.(value === n ? 0 : n);
          }}
          className={cn("leading-none", readOnly ? "cursor-default" : "cursor-pointer")}
          title={`${n} star${n === 1 ? "" : "s"}`}
        >
          <Star
            className={cn(
              "h-3.5 w-3.5",
              n <= shown ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40",
            )}
          />
        </button>
      ))}
    </div>
  );
}
