// GitHub/GitLab-style diff: per-line sign gutter + tinted add/del rows.
// Input is a preview string where lines are prefixed "+ " / "- " (from the
// backend mini-diff) or unprefixed (context / plain file content).
export function DiffView({ text }: { text: string }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <div className="diff" role="group" aria-label="diff">
      {lines.map((l, i) => {
        const add = l.startsWith("+ ") || l === "+";
        const del = l.startsWith("- ") || l === "-";
        const content = add || del ? l.slice(2) : l;
        const cls = add ? "add" : del ? "del" : "ctx";
        return (
          <div key={i} className={`diff-line ${cls}`}>
            <span className="diff-gutter">{add ? "+" : del ? "−" : ""}</span>
            <span className="diff-code">{content.length ? content : " "}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Build a diff preview string from an Edit/MultiEdit tool input (client-side,
 *  for the timeline). Returns null if the tool isn't an edit. */
export function editDiff(toolName: string | null, inputJson: string | null): string | null {
  if (!toolName || !inputJson) return null;
  const t = toolName.toLowerCase();
  if (t !== "edit" && t !== "multiedit") return null;
  let input: unknown;
  try {
    input = JSON.parse(inputJson);
  } catch {
    return null;
  }
  const one = (o: Record<string, unknown>): string => {
    const oldS = String(o.old_string ?? o.oldString ?? "");
    const newS = String(o.new_string ?? o.newString ?? "");
    const del = oldS ? oldS.split("\n").map((l) => `- ${l}`) : [];
    const add = newS ? newS.split("\n").map((l) => `+ ${l}`) : [];
    return [...del, ...add].join("\n");
  };
  const obj = input as Record<string, unknown>;
  if (Array.isArray(obj.edits)) {
    return (obj.edits as Record<string, unknown>[]).map(one).join("\n");
  }
  return one(obj);
}
