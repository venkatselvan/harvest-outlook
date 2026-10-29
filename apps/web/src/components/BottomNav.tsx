import { A } from "@solidjs/router";
import { DESTINATIONS } from "../routes/destinations";

export function BottomNav() {
  return (
    <nav class="bottom-nav" aria-label="Primary">
      <ul>
        {DESTINATIONS.map((d) => (
          <li>
            <A href={d.path} class="nav-link" end>
              {d.label}
            </A>
          </li>
        ))}
      </ul>
    </nav>
  );
}
