// Records the Narrator demo's clips: each `<p class="line narration" data-lang="xx">` of index.html,
// said by the best voice installed for its language, as the mod picks it (Siri's first), and saved
// as narrator/<xx>.m4a. A browser cannot reach the Siri voices, so the page plays these.
//
// Run on macOS after changing those lines, or after downloading a better voice (System Settings →
// Accessibility → Spoken Content → System voice → Manage Voices):
// swift web/narrator/record.swift
import AVFoundation
import Foundation

let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let page = folder.deletingLastPathComponent().appendingPathComponent("index.html")
let html = try String(contentsOf: page, encoding: .utf8)

/// The text a line shows: its tags dropped, its entities read.
func text (of fragment: String) -> String {
  let entities = ["&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": " "]
  var text = fragment.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
  for (entity, character) in entities { text = text.replacingOccurrences(of: entity, with: character) }
  return text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
}

// The region each language is heard in: the person's own where it is that language, else the usual one.
let usual = ["de": "DE", "en": "US", "es": "ES", "fr": "FR", "it": "IT", "ja": "JP", "pt": "BR", "zh": "CN"]
func region (for language: String) -> String? {
  Locale.preferredLanguages.compactMap { tag -> String? in
    let parts = tag.split(separator: "-").map(String.init)
    return parts.first == language && parts.count > 1 ? parts.last : nil
  }.first ?? usual[language]
}

/// Siri's natural voices first, then premium over enhanced over compact, then the language's region.
func bestVoice (for language: String) -> AVSpeechSynthesisVoice? {
  let preferred = region(for: language)
  func score (_ voice: AVSpeechSynthesisVoice) -> Int {
    var score = voice.quality.rawValue * 100
    if voice.identifier.contains(".siri.") { score += 1000 }
    if let preferred, voice.language.hasSuffix("-\(preferred)") { score += 50 }
    if voice.identifier.contains(".super-compact.") { score -= 1 }
    if voice.identifier.contains(".eloquence.") || voice.identifier.contains(".speech.synthesis.") { score -= 10000 }
    return score
  }
  return AVSpeechSynthesisVoice.speechVoices()
    .filter { $0.language.split(separator: "-").first.map(String.init) == language }
    .max { score($0) < score($1) }
}

/// Says `text` with `voice` into a CAF file at `url`, waiting on the main run loop till it is written.
func record (_ text: String, with voice: AVSpeechSynthesisVoice, to url: URL) throws -> Int {
  let synthesizer = AVSpeechSynthesizer()
  let utterance = AVSpeechUtterance(string: text)
  utterance.voice = voice
  var file: AVAudioFile?
  var frames = 0
  var failure: Error?
  var isDone = false
  synthesizer.write(utterance) { buffer in
    guard let pcm = buffer as? AVAudioPCMBuffer else { return }
    if pcm.frameLength == 0 { isDone = true; return }
    do {
      if file == nil { file = try AVAudioFile(forWriting: url, settings: pcm.format.settings) }
      try file?.write(from: pcm)
      frames += Int(pcm.frameLength)
    } catch {
      failure = error
      isDone = true
    }
  }
  let deadline = Date().addingTimeInterval(60)
  while !isDone && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
  if let failure { throw failure }
  return frames
}

let lines = try NSRegularExpression(pattern: #"<p class="line narration" data-lang="([a-z]{2})"[^>]*>(.*?)</p>"#, options: [.dotMatchesLineSeparators])
let matches = lines.matches(in: html, range: NSRange(html.startIndex..., in: html))
if matches.isEmpty { fatalError("no narration lines in \(page.path)") }

for match in matches {
  let language = String(html[Range(match.range(at: 1), in: html)!])
  let said = text(of: String(html[Range(match.range(at: 2), in: html)!]))
  guard let voice = bestVoice(for: language) else {
    print("\(language): no voice installed for it, skipped")
    continue
  }
  let caf = FileManager.default.temporaryDirectory.appendingPathComponent("narrator-\(language).caf")
  let out = folder.appendingPathComponent("\(language).m4a")
  let frames = try record(said, with: voice, to: caf)
  // AAC in an MP4 box: every browser plays it. Speech needs no more than 48 kbps.
  let convert = Process()
  convert.executableURL = URL(fileURLWithPath: "/usr/bin/afconvert")
  convert.arguments = ["-f", "m4af", "-d", "aac", "-b", "48000", caf.path, out.path]
  try convert.run()
  convert.waitUntilExit()
  try? FileManager.default.removeItem(at: caf)
  guard convert.terminationStatus == 0 else { fatalError("afconvert failed for \(language)") }
  let siri = voice.identifier.contains(".siri.") ? ", Siri" : ""
  print("narrator/\(language).m4a: \(voice.identifier) (\(voice.language)\(siri)), \(frames) frames")
}
