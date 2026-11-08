import { useJjLyrics } from "@/signals/useJjLyrics";

export function JjLyrics() {
  const { line, previous, sequence } = useJjLyrics();
  return (
    <div className="jj-lyrics w-full max-w-2xl px-6 text-center font-sans">
      <p aria-hidden="true" className="jj-lyrics-previous text-muted-foreground">{previous || "\u00a0"}</p>
      <p key={sequence} aria-live="polite" aria-atomic="true" className="jj-lyrics-current text-foreground">
        {line.split(/\s+/).map((word, index) => (
          <span key={index} className="jj-lyric-word">{word}{" "}</span>
        ))}
      </p>
    </div>
  );
}