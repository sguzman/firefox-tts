/* Firefox UI: only installed offline Piper models may appear in the catalog. */
(function attachPiperOnlyVoiceUi(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root.EdgeTtsExtension?.Toolbar?.Toolbar) {
    api.installVoiceUi(root.EdgeTtsExtension.Toolbar.Toolbar);
    root.EdgeTtsExtension.VoiceUi = api;
  }
})(globalThis, function makePiperVoiceUi() {
  const voiceClass = voice => voice?.__edgeTtsSource === "linux-piper" ? "piper" : "unsupported";
  const voicePrefix = voice => voiceClass(voice) === "piper" ? "[PIPER]" : "[UNAVAILABLE]";
  const voiceLabel = voice =>
    `${voicePrefix(voice)} ${voice?.name || "Unnamed voice"}${voice?.lang ? ` — ${voice.lang}` : ""}`;
  function filterVoicesByClass(voices, query = "", selectedClass = "all") {
    if (selectedClass !== "all" && selectedClass !== "piper") return [];
    const terms = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (voices || []).filter(voice => {
      if (voiceClass(voice) !== "piper") return false;
      const search = `${voice.name || ""} ${voice.lang || ""} piper`.toLowerCase();
      return terms.every(term => search.includes(term));
    });
  }
  function installVoiceUi(Toolbar) {
    const prototype = Toolbar?.prototype;
    if (!prototype || prototype.__firefoxTtsPiperVoiceUiInstalled) return false;
    Object.defineProperty(prototype, "__firefoxTtsPiperVoiceUiInstalled", { value: true });
    prototype.renderVoiceOptions = function renderPiperOptions() {
      if (!this.voiceSelect) return;
      const query = this.voiceFilterInput?.value || "";
      const voices = filterVoicesByClass(this.voices, query);
      this.voiceSelect.replaceChildren();
      if (!voices.length) {
        const empty = document.createElement("option");
        empty.value = "";
        empty.textContent = "No installed Piper voices match";
        empty.disabled = true;
        empty.selected = true;
        this.voiceSelect.appendChild(empty);
      } else if (!voices.some(v => v.name === this.selectedVoiceName)) {
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Choose a Piper voice";
        placeholder.disabled = true;
        placeholder.selected = true;
        this.voiceSelect.appendChild(placeholder);
      }
      for (const voice of voices) {
        const option = document.createElement("option");
        option.value = voice.name;
        option.textContent = voiceLabel(voice);
        option.selected = voice.name === this.selectedVoiceName;
        this.voiceSelect.appendChild(option);
      }
      if (this.clearVoiceFilterButton) {
        this.clearVoiceFilterButton.disabled = query.length === 0;
      }
    };
    return true;
  }
  return { voiceClass, voicePrefix, voiceLabel, filterVoicesByClass, installVoiceUi };
});
