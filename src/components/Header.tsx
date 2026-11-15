"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const links = [
  { href: "/#challenge", label: "Challenge" },
  { href: "/#blink", label: "Blink" },
  { href: "/#approach", label: "Approach" },
  { href: "/#targets", label: "Targets" },
  { href: "/gallery", label: "Gallery" },
  { href: "/data-analysis", label: "Data analysis" },
];

const specks = [
  { left: "18%", top: "22%", tone: "" },
  { left: "24%", top: "68%", tone: "is-soft" },
  { left: "29%", top: "36%", tone: "is-bright" },
  { left: "36%", top: "74%", tone: "" },
  { left: "43%", top: "18%", tone: "is-soft" },
  { left: "49%", top: "58%", tone: "" },
  { left: "57%", top: "30%", tone: "is-bright" },
  { left: "64%", top: "72%", tone: "is-soft" },
  { left: "71%", top: "24%", tone: "" },
  { left: "78%", top: "64%", tone: "is-soft" },
  { left: "86%", top: "32%", tone: "is-bright" },
  { left: "92%", top: "70%", tone: "" },
];

const crosses = [
  { left: "33%", top: "42%" },
  { left: "54%", top: "46%", tiny: true },
  { left: "74%", top: "40%" },
];

export default function Header({ pinned = false, resting = false }: { pinned?: boolean; resting?: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [inHero, setInHero] = useState(resting || !pinned);
  const [narrowTool, setNarrowTool] = useState(false);

  useEffect(() => {
    if (resting) {
      setInHero(true);
      return;
    }
    if (pinned) {
      setInHero(false);
      return;
    }
    const flight = document.getElementById("top");
    const update = () => {
      if (!flight) {
        setInHero(false);
        return;
      }
      const rect = flight.getBoundingClientRect();
      setInHero(rect.bottom > 96);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [pinned, resting]);

  useEffect(() => {
    if (!resting) {
      setNarrowTool(false);
      return;
    }
    const sync = () => {
      const width = Math.min(
        window.innerWidth,
        document.documentElement.clientWidth || window.innerWidth,
      );
      setNarrowTool(width <= 1100);
    };
    sync();
    window.addEventListener("resize", sync);
    window.visualViewport?.addEventListener("resize", sync);
    return () => {
      window.removeEventListener("resize", sync);
      window.visualViewport?.removeEventListener("resize", sync);
    };
  }, [resting]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const compactTool = resting && narrowTool;
  const headerClass = [
    "site-header",
    inHero && !open ? "is-resting" : "",
    compactTool ? "is-tool-compact" : "",
    compactTool && open ? "is-tool-compact-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <header className={headerClass}>
      {compactTool ? (
        <>
          <button
            className={open ? "tool-nav-fab burger open" : "tool-nav-fab burger"}
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <span />
            <span />
            <span />
          </button>
          {open ? (
            <nav className="mobile-menu is-dark tool-nav-menu" aria-label="Mobile">
              {links.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  aria-current={pathname === link.href ? "page" : undefined}
                  onClick={() => setOpen(false)}
                >
                  {link.label}
                </a>
              ))}
              <a className="btn" href="/tool?enter=1" onClick={() => setOpen(false)}>
                The tool
              </a>
            </nav>
          ) : null}
        </>
      ) : (
        <div className="container" style={{ position: "relative" }}>
          <div className="header-bar is-dark">
            <div className="header-sky" aria-hidden="true">
              {specks.map((speck) => (
                <span
                  key={`${speck.left}-${speck.top}`}
                  className={speck.tone ? `pixel ${speck.tone}` : "pixel"}
                  style={{ left: speck.left, top: speck.top }}
                />
              ))}
              {crosses.map((cross) => (
                <span
                  key={cross.left}
                  className={cross.tiny ? "pixel-cross is-tiny" : "pixel-cross"}
                  style={{ left: cross.left, top: cross.top }}
                />
              ))}
            </div>
            <a href="/" className="brand">
              <span className="brand-mark">
                <img src="/logo.png" alt="" width={52} height={52} />
              </span>
              <span>
                <span className="brand-name">Flickering Pixels</span>
                <span className="brand-sub">Planet X · SPHEREx</span>
              </span>
            </a>

            <nav className="nav" aria-label="Main">
              {links.map((link) => (
                <a key={link.href} href={link.href} aria-current={pathname === link.href ? "page" : undefined}>
                  {link.label}
                </a>
              ))}
            </nav>

            <div className="header-actions">
              <a className="btn header-cta" href="/tool?enter=1">
                The tool
              </a>
              <button
                className={open ? "burger open" : "burger"}
                type="button"
                aria-label={open ? "Close menu" : "Open menu"}
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
              >
                <span />
                <span />
                <span />
              </button>
            </div>
          </div>

          {open && (
            <nav className="mobile-menu is-dark" aria-label="Mobile">
              {links.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  aria-current={pathname === link.href ? "page" : undefined}
                  onClick={() => setOpen(false)}
                >
                  {link.label}
                </a>
              ))}
              <a className="btn" href="/tool?enter=1" onClick={() => setOpen(false)}>
                The tool
              </a>
            </nav>
          )}
        </div>
      )}
    </header>
  );
}
