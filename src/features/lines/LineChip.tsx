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
  const style = { backgroundColor: `#${color}`, color: `#${textColor}` }
  const classes = cn(
    "inline-flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-sm font-bold shadow-sm",
    className
  )
  // Render a span when non-interactive so chips can sit inside other buttons
  if (!onClick) {
    return (
      <span style={style} className={classes}>
        {id}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      style={style}
      className={cn(
        classes,
        "cursor-pointer transition-transform hover:scale-105 active:scale-95"
      )}
    >
      {id}
    </button>
  )
}
