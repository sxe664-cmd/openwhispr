const MEETING_URL_PATTERN =
  /https?:\/\/[^\s<>"']*(?:zoom\.us\/j\/|meet\.google\.com\/|teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com\/meet\/|\.webex\.com\/|chime\.aws\/)[^\s<>"']*/i;

export function getMeetingJoinUrl(event) {
  if (!event) return null;
  const hangoutLink = safeMeetingUrl(event.hangout_link);
  if (hangoutLink) return hangoutLink;
  if (!event.conference_data) return null;
  try {
    const data = JSON.parse(event.conference_data);
    const uri = data?.entryPoints
      ?.find((ep) => ep.entryPointType === "video" && safeMeetingUrl(ep.uri))
      ?.uri;
    return safeMeetingUrl(uri);
  } catch {
    return null;
  }
}

export function getCalendarEventUrl(event) {
  const value = event?.html_link;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    const host = url.hostname.toLowerCase();
    if (host === "calendar.google.com") return url.toString();
    return host === "www.google.com" && url.pathname.startsWith("/calendar/") ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeMeetingUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    const host = url.hostname.toLowerCase();
    const path = url.pathname || "/";
    const zoom = (host === "zoom.us" || host.endsWith(".zoom.us")) && path.startsWith("/j/");
    const meet = host === "meet.google.com";
    const teams = (host === "teams.microsoft.com" && path.startsWith("/l/meetup-join")) || (host === "teams.live.com" && path.startsWith("/meet/"));
    const webex = host.endsWith(".webex.com");
    const chime = host === "chime.aws";
    return zoom || meet || teams || webex || chime ? url.toString() : null;
  } catch {
    return null;
  }
}

// Finds a meeting link in loose text (EventKit has no structured conference
// data — Zoom/Meet/Teams/Webex links live in url, location, or notes).
export function extractMeetingUrl(candidates) {
  if (!Array.isArray(candidates)) return null;
  for (const candidate of candidates) {
    const match = candidate?.match?.(MEETING_URL_PATTERN);
    if (match) return match[0].replace(/[),.;:!?]+$/, "");
  }
  return null;
}
