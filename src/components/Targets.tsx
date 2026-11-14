import { DeckCartridge, DeckLed } from "@/components/deck/DeckPrimitives";

const targets = [
  {
    name: "WISE 0855",
    kind: "Brown dwarf",
    text: "Coldest known. If it walks vs AllWISE, the blink is honest.",
    coord: "RA 08h 55m · Dec −7° 14′",
    signal: "Moves",
    moves: true,
    primary: true,
  },
  {
    name: "Barnard's Star",
    kind: "Nearby star",
    text: "High proper motion — should slide between visits.",
    coord: "High proper motion",
    signal: "Moves",
    moves: true,
  },
  {
    name: "Epsilon Indi B",
    kind: "Brown dwarf",
    text: "A nearby companion — a clean second mover test.",
    coord: "Companion of ε Indi",
    signal: "Moves",
    moves: true,
  },
  {
    name: "RW Aurigae",
    kind: "Young star",
    text: "Variable brightness — should hold position.",
    coord: "Taurus",
    signal: "Holds",
    moves: false,
  },
  {
    name: "R Draconis",
    kind: "Variable star",
    text: "Long-period variable — position, not pulse.",
    coord: "Mira-type",
    signal: "Holds",
    moves: false,
  },
];

export default function Targets() {
  return (
    <section className="section deck-section" id="targets">
      <div className="container">
        <header className="deck-head">
          <div className="deck-head-meta">
            <DeckLed tone="amber" />
            <p className="kicker">Proving ground</p>
          </div>
          <h2>Five places the blink must tell the truth.</h2>
          <p className="section-lead">
            Start with WISE 0855. Movers move. Variables that stay put stay put.
          </p>
        </header>

        <div className="deck-magazine" aria-label="Challenge targets">
          {targets.map((target, index) => (
            <DeckCartridge
              key={target.name}
              primary={target.primary}
              active={target.moves}
            >
              <div className="deck-cartridge-meta">
                <span className="deck-slot">SLOT {String(index + 1).padStart(2, "0")}</span>
                <span className={target.moves ? "deck-pill is-move" : "deck-pill is-hold"}>
                  <DeckLed tone={target.moves ? "cyan" : "amber"} pulse={target.moves} />
                  {target.signal}
                </span>
              </div>
              <p className="deck-cartridge-kind">{target.kind}</p>
              <h3>{target.name}</h3>
              <p>{target.text}</p>
              <div className="deck-coord">{target.coord}</div>
            </DeckCartridge>
          ))}
        </div>
      </div>
    </section>
  );
}
