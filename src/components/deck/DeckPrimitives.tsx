import type { CSSProperties, ReactNode } from "react";

export function DeckLed({
  tone = "cyan",
  pulse = false,
  label,
}: {
  tone?: "cyan" | "green" | "amber" | "dim";
  pulse?: boolean;
  label?: string;
}) {
  return (
    <span
      className={`deck-led is-${tone}${pulse ? " is-pulse" : ""}`}
      title={label}
      aria-hidden={label ? undefined : true}
      aria-label={label}
    />
  );
}

export function DeckChassis({
  children,
  className = "",
  label,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <div className={`deck-chassis ${className}`.trim()}>
      <span className="deck-chassis-rail is-left" aria-hidden="true" />
      <span className="deck-chassis-rail is-right" aria-hidden="true" />
      {label ? <p className="deck-chassis-label">{label}</p> : null}
      <div className="deck-chassis-body">{children}</div>
    </div>
  );
}

export function DeckLcd({
  value,
  unit,
  caption,
}: {
  value: string;
  unit?: string;
  caption: string;
}) {
  return (
    <article className="deck-lcd">
      <div className="deck-lcd-glass">
        <strong>
          {value}
          {unit ? <small>{unit}</small> : null}
        </strong>
      </div>
      <span>{caption}</span>
    </article>
  );
}

export function DeckBay({
  children,
  title,
  index,
  footer,
  className = "",
}: {
  children: ReactNode;
  title: string;
  index?: string;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <article className={`deck-bay ${className}`.trim()}>
      <header className="deck-bay-head">
        <span className="deck-bay-latch" aria-hidden="true" />
        {index ? <span className="deck-bay-index">{index}</span> : null}
        <h3>{title}</h3>
        <DeckLed tone="green" />
      </header>
      <div className="deck-bay-well">{children}</div>
      {footer ? <footer className="deck-bay-foot">{footer}</footer> : null}
    </article>
  );
}

export function DeckVu({ bars }: { bars: number[] }) {
  return (
    <div className="deck-vu" aria-hidden="true">
      {bars.map((height, index) => (
        <i key={index} style={{ ["--h" as string]: `${height}%` } as CSSProperties} />
      ))}
    </div>
  );
}

export function DeckSwitch({ on = true, label }: { on?: boolean; label: string }) {
  return (
    <div className={`deck-switch${on ? " is-on" : ""}`} aria-hidden="true" title={label}>
      <span className="deck-switch-rocker" />
      <small>{label}</small>
    </div>
  );
}

export function DeckScope({ children, caption }: { children: ReactNode; caption?: ReactNode }) {
  return (
    <div className="deck-scope">
      <div className="deck-scope-bezel">
        <div className="deck-scope-glass">{children}</div>
      </div>
      {caption ? <div className="deck-scope-caption">{caption}</div> : null}
    </div>
  );
}

export function DeckCartridge({
  children,
  primary = false,
  active = false,
}: {
  children: ReactNode;
  primary?: boolean;
  active?: boolean;
}) {
  return (
    <article className={`deck-cartridge${primary ? " is-primary" : ""}${active ? " is-active" : ""}`}>
      <span className="deck-cartridge-tab" aria-hidden="true" />
      <div className="deck-cartridge-body">{children}</div>
      <span className="deck-cartridge-edge" aria-hidden="true" />
    </article>
  );
}

export function DeckNameplate({ children }: { children: ReactNode }) {
  return <div className="deck-nameplate">{children}</div>;
}

export function DeckBtn({
  href,
  children,
  external = false,
}: {
  href: string;
  children: ReactNode;
  external?: boolean;
}) {
  return (
    <a
      className="deck-btn"
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      <span className="deck-btn-cap" aria-hidden="true" />
      {children}
    </a>
  );
}
