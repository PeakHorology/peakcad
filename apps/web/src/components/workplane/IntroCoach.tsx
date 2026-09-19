"use client";

type IntroCoachProps = {
  onDismiss: () => void;
};

export function IntroCoach({ onDismiss }: IntroCoachProps) {
  return (
    <aside className="intro-coach" aria-label="How this sample works">
      <header>
        <strong>Start here</strong>
        <button type="button" aria-label="Dismiss intro" onClick={onDismiss}>
          Got it
        </button>
      </header>
      <ol>
        <li>
          <span>1</span>
          The red box is a <em>solid</em>.
        </li>
        <li>
          <span>2</span>
          The cylinder is a <em>hole</em> through it.
        </li>
        <li>
          <span>3</span>
          <em>Group</em> fused them into one part. Use <em>Export</em> for Exact STEP.
        </li>
      </ol>
    </aside>
  );
}
