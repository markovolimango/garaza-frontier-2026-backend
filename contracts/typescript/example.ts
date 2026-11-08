// Example for a future frontend (not a UI): follow coaching suggestions and speaking metrics.
import { CoachClient } from "./coach-client";

const client = new CoachClient({ baseUrl: "http://127.0.0.1:8765", token: "<operator token>" });

const subscription = client.subscribe({
  sessionId: "latest",
  eventTypes: ["session.state", "coaching.feedback", "speech.metrics", "heart_rate.state", "body.metrics"],
  onSnapshot: (snapshot, cursor) => console.log("state at cursor", cursor, snapshot["session"]),
  onEvent: (event, replay) => {
    if (event.event_type === "coaching.feedback") {
      const payload = event.payload as { display_text: string; rule_id: string };
      console.log(replay ? "(missed)" : "(live)", payload.rule_id, payload.display_text);
    }
    if (event.source.simulated) console.log("simulated data:", event.event_type);
  },
  onHistoryExpired: () => console.log("history expired; timeline reset from the next snapshot"),
  onStatus: (status, detail) => console.log("stream", status, detail ?? ""),
});

setTimeout(() => subscription.close(), 60_000);
