const targets = [
  {
    name: "WISE 0855",
    kind: "Brown dwarf",
    text: "Coldest known. If it walks vs AllWISE, the blink is honest.",
    signal: "Moves",
    moves: true,
  },
  {
    name: "Barnard's Star",
    kind: "Nearby star",
    text: "High proper motion — should slide between visits.",
    signal: "Moves",
    moves: true,
  },
  {
    name: "Epsilon Indi B",
    kind: "Brown dwarf",
    text: "A nearby companion — a second clean mover test.",
    signal: "Moves",
    moves: true,
  },
  {
    name: "RW Aurigae",
    kind: "Young star",
    text: "Variable brightness — should hold its place.",
    signal: "Holds",
    moves: false,
  },
  {
    name: "R Draconis",
    kind: "Variable star",
    text: "Long-period variable — position, not pulse.",
    signal: "Holds",
    moves: false,
  },
  {
    name: "M101",
    kind: "Spiral galaxy",
    text: "A whole island of stars — so far it holds still across visits.",
    signal: "Holds",
    moves: false,
  },
];

export default function Targets() {
  return (
    <section className="section deck-section" id="targets">
      <div className="container">
        <header className="deck-head targets-head">
          <p className="kicker">Proving ground</p>
          <h2>Six places the blink must tell the truth.</h2>
          <p className="section-lead">
            Movers should move. Variables and galaxies that stay put should stay put. Start with WISE 0855.
          </p>
        </header>

        <ul className="targets-list" aria-label="Challenge targets">
          {targets.map((target) => (
            <li key={target.name} className={target.moves ? "targets-item is-move" : "targets-item is-hold"}>
              <div className="targets-item-top">
                <p className="targets-kind">{target.kind}</p>
                <span className="targets-signal">{target.signal}</span>
              </div>
              <h3>{target.name}</h3>
              <p className="targets-text">{target.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
