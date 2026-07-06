import { cn } from "@/lib/utils"

export function LineChip({
  id,
  color,
  textColor,
  onClick,
  className,
}: {
  id: string
  color: string
  textColor: string
  onClick?: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      style={{ backgroundColor: `#${color}`, color: `#${textColor}` }}
      className={cn(
        "inline-flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-sm font-bold shadow-sm transition-transform",
        onClick && "cursor-pointer hover:scale-105 active:scale-95",
        className
      )}
    >
      {id}
    </button>
  )
}
