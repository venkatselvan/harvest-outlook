import { Evara } from "./Evara";
import { Icon } from "./icons";
export function FarmStart(props: {
  onReal: () => void;
  onDemo: () => void;
  busy: boolean;
  error: string;
}) {
  return (
    <section class="farm-start">
      <div class="farm-start-intro">
        <Evara size={73} />
        <div>
          <p class="eyebrow">WELCOME TO YOUR NEXT SEASON</p>
          <h2>
            Start with your land.
            <br />
            Or take a look around.
          </h2>
          <p>
            I'm Evara. I'll help you map a farm, explore crop choices, and keep
            your seasons connected.
          </p>
        </div>
        <svg
          class="farm-start-landscape"
          viewBox="0 0 500 140"
          fill="none"
          aria-hidden="true"
        >
          <path d="M0 98Q100 24 230 89T500 76V140H0Z" fill="#D6E1BD" />
          <path d="M0 122Q160 62 315 110T500 105V140H0Z" fill="#B8CC94" />
          <path
            d="m40 140 98-55m-32 55 84-42m-14 42 64-29m16 29 41-15m42 15 14-5"
            stroke="#91AB73"
            stroke-width="2"
          />
          <path
            d="M375 91V52m0 13c-17-1-24-9-24-22 14 1 24 10 24 22Zm0 12c17-1 25-9 25-22-16 1-25 10-25 22Z"
            stroke="#72925A"
            stroke-width="2"
            fill="#A7BE7D"
          />
          <circle cx="432" cy="33" r="14" fill="#F0E6B9" />
        </svg>
      </div>
      <div class="farm-start-options">
        <button
          class="start-option real"
          onClick={props.onReal}
          disabled={props.busy}
        >
          <span class="start-option-icon">
            <Icon name="draw" size={27} />
          </span>
          <span class="eyebrow">YOUR OWN LAND</span>
          <h3>Set up my farm</h3>
          <p>
            Find your land and trace its boundary. Evara will help fill in the
            location and area for you to review.
          </p>
          <strong>
            Map your farm <Icon name="arrow" size={18} />
          </strong>
        </button>
        <button
          class="start-option demo"
          onClick={props.onDemo}
          disabled={props.busy}
        >
          <span class="start-option-icon">
            <Icon name="leaf" size={27} />
          </span>
          <span class="eyebrow">A GUIDED FIRST LOOK</span>
          <h3>{props.busy ? "Preparing your demo…" : "Load a demo farm"}</h3>
          <p>
            Start on a farm that has used the app for two years: past harvests,
            a journal and the crop in the field now. No future seasons are saved, so
            you generate the plan.
          </p>
          <strong>
            {props.busy ? "Loading…" : "Explore the demo"}
            <Icon name="arrow" size={18} />
          </strong>
        </button>
      </div>
      <p class="farm-start-note">
        <Icon name="check" size={14} />
        The demo farm's records are samples. Your farms stay separate.
      </p>
      {props.error ? (
        <p class="inline-error" role="alert">
          {props.error}
        </p>
      ) : null}
    </section>
  );
}
