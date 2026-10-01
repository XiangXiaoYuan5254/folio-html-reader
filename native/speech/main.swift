// The whiteboard teacher's voice and ears on macOS, all on this computer: it says sentences
// with the system's voices and, in a voice conversation, listens through the microphone and
// writes down what the student says. Electron talks to it in JSON lines on stdin and stdout.
//
// In:  {"type":"voices"}
//      {"type":"prepare","id","text","voice"}   synthesize a sentence ahead of saying it
//      {"type":"say","id"}                      say a prepared sentence
//      {"type":"pause"} {"type":"resume"} {"type":"hush"} {"type":"speed","rate"}
//      {"type":"listen","on","locale"}          start or stop listening
//      {"type":"mute","on"}                     ignore the microphone for a while
// Out: {"type":"voices","voices":[…]}
//      {"type":"ready","id","ms"} {"type":"fail","id","message"} {"type":"done","id"}
//      {"type":"listening","on"} {"type":"installing"} {"type":"level","v"}
//      {"type":"heard","text"} {"type":"utterance","text"} {"type":"error","message"}
//
// The teacher's voice plays through the same audio engine the microphone is read from, so
// with voice processing on, the system's echo canceller removes it from what is heard.

import AVFoundation
import CoreAudio
import Foundation
import Speech

let output = DispatchQueue(label: "folio.speech.out")
func emit(_ message: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
  output.async {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
  }
}
func log(_ text: String) {
  FileHandle.standardError.write((text + "\n").data(using: .utf8)!)
}

// Channel 0 of a buffer as floats: synthesized speech comes as 16-bit or float, and a voice
// processing microphone can report several channels of which the first is the processed one.
func samples(_ buffer: AVAudioPCMBuffer) -> [Float] {
  let n = Int(buffer.frameLength)
  if let f = buffer.floatChannelData { return Array(UnsafeBufferPointer(start: f[0], count: n)) }
  if let i = buffer.int16ChannelData {
    let stride = buffer.format.isInterleaved ? Int(buffer.format.channelCount) : 1
    return (0..<n).map { Float(i[0][$0 * stride]) / 32768 }
  }
  return []
}
func pcm(_ values: [Float], rate: Double) -> AVAudioPCMBuffer? {
  guard let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1),
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(max(1, values.count)))
  else { return nil }
  buffer.frameLength = AVAudioFrameCount(values.count)
  values.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: values.count) }
  return buffer
}
// Everything is said at one rate, so the engine never has to be rewired while it runs;
// a voice that speaks at another rate is converted to it.
let speechRate = 22050.0
let speechFormat = AVAudioFormat(standardFormatWithSampleRate: speechRate, channels: 1)!
func resampled(_ values: [Float], from rate: Double) -> [Float] {
  guard rate != speechRate, let input = pcm(values, rate: rate),
    let out = Resampler(from: input.format, to: speechFormat)?.convert(input)
  else { return values }
  return samples(out)
}
// Converts a stream of buffers to the format the recognizer wants.
final class Resampler {
  let converter: AVAudioConverter
  let to: AVAudioFormat
  init?(from: AVAudioFormat, to: AVAudioFormat) {
    guard let c = AVAudioConverter(from: from, to: to) else { return nil }
    converter = c
    self.to = to
  }
  func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    let ratio = to.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 32)
    guard let out = AVAudioPCMBuffer(pcmFormat: to, frameCapacity: capacity) else { return nil }
    var given = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if given {
        status.pointee = .noDataNow
        return nil
      }
      given = true
      status.pointee = .haveData
      return buffer
    }
    return error == nil && out.frameLength > 0 ? out : nil
  }
}

// Writes down speech. `feed` is called on the audio thread; results come back on main.
protocol Ears: AnyObject {
  func feed(_ buffer: AVAudioPCMBuffer)
  // Everything heard so far, made final, then listening goes on.
  func finish(_ done: @escaping (String) -> Void)
  func stop()
}

@available(macOS 26.0, *)
final class Analyzer: Ears {
  private let analyzer: SpeechAnalyzer
  private let transcriber: SpeechTranscriber
  private let input: AsyncStream<AnalyzerInput>.Continuation
  private var resampler: Resampler?
  private let format: AVAudioFormat
  private var fed: Int64 = 0
  private var results: Task<Void, Never>?
  // What was said since the last utterance: finished stretches and the one being heard.
  private var finals = ""
  private var volatile = ""
  private let heard: (String) -> Void

  static func make(locale: Locale, heard: @escaping (String) -> Void) async throws -> Analyzer {
    guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
      throw Failure("这台 Mac 的语音识别不支持\(locale.identifier)")
    }
    let transcriber = SpeechTranscriber(
      locale: supported, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults],
      attributeOptions: [])
    let installed = await SpeechTranscriber.installedLocales.contains {
      $0.identifier(.bcp47) == supported.identifier(.bcp47)
    }
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      if !installed { emit(["type": "installing"]) }
      try await request.downloadAndInstall()
    }
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      throw Failure("语音识别不可用")
    }
    let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    try await analyzer.start(inputSequence: stream)
    return Analyzer(analyzer, transcriber, input, format, heard)
  }
  private init(
    _ analyzer: SpeechAnalyzer, _ transcriber: SpeechTranscriber,
    _ input: AsyncStream<AnalyzerInput>.Continuation, _ format: AVAudioFormat,
    _ heard: @escaping (String) -> Void
  ) {
    self.analyzer = analyzer
    self.transcriber = transcriber
    self.input = input
    self.format = format
    self.heard = heard
    results = Task { [weak self] in
      do {
        for try await r in transcriber.results {
          let text = String(r.text.characters)
          DispatchQueue.main.async {
            guard let self else { return }
            if r.isFinal {
              self.finals += text
              self.volatile = ""
            } else {
              self.volatile = text
            }
            self.heard(self.finals + self.volatile)
          }
        }
      } catch {
        emit(["type": "error", "message": "语音识别出错：\(error.localizedDescription)"])
      }
    }
  }
  func feed(_ buffer: AVAudioPCMBuffer) {
    if resampler == nil || resampler!.converter.inputFormat != buffer.format {
      resampler = Resampler(from: buffer.format, to: format)
    }
    guard let out = resampler?.convert(buffer) else { return }
    fed += Int64(out.frameLength)
    input.yield(AnalyzerInput(buffer: out))
  }
  func finish(_ done: @escaping (String) -> Void) {
    // The analyzer holds back the last moment of what it was given until more comes, so
    // finalizing right up to the end would wait for the next words. It is called after a
    // pause, so the end is silence anyway.
    let rate = Int64(format.sampleRate)
    let through = CMTime(value: max(0, fed - rate / 4), timescale: CMTimeScale(rate))
    var sent = false
    let send = {
      guard !sent else { return }
      sent = true
      let text = self.finals + self.volatile
      self.finals = ""
      self.volatile = ""
      done(text)
    }
    Task {
      try? await self.analyzer.finalize(through: through)
      // The final results are delivered just after finalizing returns.
      try? await Task.sleep(nanoseconds: 120_000_000)
      DispatchQueue.main.async(execute: send)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: send)
  }
  func stop() {
    input.finish()
    results?.cancel()
    let analyzer = self.analyzer
    Task { await analyzer.cancelAndFinishNow() }
  }
}

// Before macOS 26: the older recognizer, one request per utterance, on this computer where
// the system supports it.
final class Recognizer: Ears {
  private let recognizer: SFSpeechRecognizer
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var text = ""
  private var ending: ((String) -> Void)?
  private let heard: (String) -> Void
  private let lock = NSLock()

  static func make(locale: Locale, heard: @escaping (String) -> Void) async throws -> Recognizer {
    guard let recognizer = SFSpeechRecognizer(locale: locale) else {
      throw Failure("这台 Mac 的语音识别不支持\(locale.identifier)")
    }
    let status = await withCheckedContinuation { c in
      SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
    }
    guard status == .authorized else {
      throw Failure("没有语音识别权限：请在「系统设置 › 隐私与安全性 › 语音识别」里允许「页间」")
    }
    return Recognizer(recognizer, heard)
  }
  private init(_ recognizer: SFSpeechRecognizer, _ heard: @escaping (String) -> Void) {
    self.recognizer = recognizer
    self.heard = heard
    begin()
  }
  private func begin() {
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
    if #available(macOS 13.0, *) { request.addsPunctuation = true }
    text = ""
    lock.lock()
    self.request = request
    lock.unlock()
    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      DispatchQueue.main.async {
        guard let self, self.request === request else { return }
        if let result {
          self.text = result.bestTranscription.formattedString
          self.heard(self.text)
        }
        if error != nil || result?.isFinal == true {
          let done = self.ending
          let said = self.text
          self.ending = nil
          // A request ends after a while of silence too; listening goes on with a new one.
          self.begin()
          done?(said)
        }
      }
    }
  }
  func feed(_ buffer: AVAudioPCMBuffer) {
    lock.lock()
    let request = self.request
    lock.unlock()
    request?.append(buffer)
  }
  func finish(_ done: @escaping (String) -> Void) {
    ending = done
    request?.endAudio()
  }
  func stop() {
    lock.lock()
    request = nil
    lock.unlock()
    task?.cancel()
  }
}

struct Failure: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

final class Helper: NSObject, AVSpeechSynthesizerDelegate {
  private var engine = AVAudioEngine()
  private var player = AVAudioPlayerNode()
  private var pitch = AVAudioUnitTimePitch()
  private let synth = AVSpeechSynthesizer()
  private var jobs: [(id: String, text: String, voice: String)] = []
  private var making: (id: String, samples: [Float], rate: Double)?
  private var utterance: AVSpeechUtterance?
  private var clips: [String: AVAudioPCMBuffer] = [:]
  private var sayNext: String?
  private var playing: String?
  // Bumped by hush, so callbacks from before it are ignored.
  private var generation = 0
  private var paused = false
  private var rate: Float = 1

  private var listening = false
  // How the microphone is set up, best first: on the engine that plays with voice processing,
  // so the system's echo canceller knows what the teacher is saying; with voice processing on
  // an engine of its own beside the one that plays; or plain. Which works depends on the
  // devices: a USB microphone with Bluetooth headphones can't share a voice processing engine.
  private enum Setup: String, CaseIterable { case shared, separate, plain }
  private var setup = Setup.shared
  private var micEngine: AVAudioEngine?
  // The engine the microphone is tapped on.
  private var tapped: AVAudioEngine?
  private var rebuilds: [Date] = []
  private var locale = "zh-CN"
  // Set on main and read on the audio thread.
  private let earsLock = NSLock()
  private var _ears: Ears?
  private var ears: Ears? {
    get { earsLock.withLock { _ears } }
    set { earsLock.withLock { _ears = newValue } }
  }
  private var muted = false
  private var starting = 0
  // Voice activity, from the loudness of what the microphone hears.
  private var noise = -60.0
  private var voiced = 0.0
  private var silent = 0.0
  private var talking = false
  private var text = ""
  private var changed = Date()
  private var finishing = false
  private var lastLevel = Date.distantPast
  // For tests: a recording played in as if it came from the microphone, and no sound out.
  private let environment = ProcessInfo.processInfo.environment
  private var recording: DispatchSourceTimer?

  override init() {
    super.init()
    synth.delegate = self
    rebuild()
    NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main
    ) { [weak self] note in
      guard let self, let changed = note.object as? AVAudioEngine,
        changed === self.engine || changed === self.micEngine
      else { return }
      self.configurationChanged()
    }
  }

  func handle(_ m: [String: Any]) {
    switch m["type"] as? String {
    case "voices": emit(["type": "voices", "voices": voices()])
    case "prepare":
      guard let id = m["id"] as? String, let text = m["text"] as? String else { return }
      jobs.append((id, text, m["voice"] as? String ?? ""))
      makeNext()
    case "say":
      guard let id = m["id"] as? String else { return }
      say(id)
    case "pause":
      paused = true
      if engine.isRunning { player.pause() }
    case "resume":
      paused = false
      if playing != nil { play() }
    case "hush": hush()
    case "speed":
      rate = Float(max(0.5, min(3, m["rate"] as? Double ?? 1)))
      pitch.rate = rate
    case "listen":
      let on = m["on"] as? Bool ?? false
      locale = m["locale"] as? String ?? locale
      listen(on)
    case "mute":
      muted = m["on"] as? Bool ?? false
      if muted { resetHearing() }
    default: break
    }
  }

  // MARK: speaking

  private func voices() -> [[String: Any]] {
    AVSpeechSynthesisVoice.speechVoices()
      .filter { $0.language.hasPrefix("zh") || $0.language.hasPrefix("en") }
      .map { v in
        var novelty = v.identifier.contains("eloquence") || v.identifier.contains("speech.synthesis")
        if #available(macOS 14.0, *) {
          novelty = novelty || v.voiceTraits.contains(.isNoveltyVoice)
          if v.voiceTraits.contains(.isPersonalVoice) { novelty = true }
        }
        return [
          "id": v.identifier, "name": v.name, "lang": v.language, "quality": v.quality.rawValue,
          "novelty": novelty,
        ]
      }
  }
  private func makeNext() {
    guard making == nil, !jobs.isEmpty else { return }
    let job = jobs.removeFirst()
    let utterance = AVSpeechUtterance(string: job.text)
    if !job.voice.isEmpty, let voice = AVSpeechSynthesisVoice(identifier: job.voice) {
      utterance.voice = voice
    } else {
      utterance.voice = AVSpeechSynthesisVoice(language: locale)
    }
    making = (job.id, [], 0)
    self.utterance = utterance
    let generation = self.generation
    synth.write(utterance) { [weak self] buffer in
      guard let buffer = buffer as? AVAudioPCMBuffer else { return }
      // The buffer is reused once this returns.
      let chunk = samples(buffer)
      let rate = buffer.format.sampleRate
      let end = buffer.frameLength == 0
      DispatchQueue.main.async {
        guard let self, generation == self.generation, self.making?.id == job.id else { return }
        if end { return self.made() }
        self.making!.samples += chunk
        self.making!.rate = rate
      }
    }
  }
  func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    // Some voices end without the empty buffer; the samples before this have arrived.
    let generation = self.generation
    DispatchQueue.main.async { [weak self] in
      guard let self, generation == self.generation, self.utterance === utterance else { return }
      self.made()
    }
  }
  private func made() {
    guard let job = making else { return }
    making = nil
    utterance = nil
    var values = resampled(job.samples, from: job.rate)
    // Silence at the ends would only delay the words and what is drawn with them.
    let quiet: Float = 0.004
    if let first = values.firstIndex(where: { abs($0) > quiet }),
      let last = values.lastIndex(where: { abs($0) > quiet })
    {
      let pad = Int(speechRate * 0.04)
      values = Array(values[max(0, first - pad)...min(values.count - 1, last + pad * 2)])
    } else {
      values = []
    }
    if values.isEmpty || job.rate == 0 {
      emit(["type": "fail", "id": job.id, "message": "这句话没有合成出声音"])
    } else if let buffer = pcm(values, rate: speechRate) {
      clips[job.id] = buffer
      emit(["type": "ready", "id": job.id, "ms": Double(values.count) / speechRate * 1000])
      if sayNext == job.id { say(job.id) }
    }
    makeNext()
  }
  private func say(_ id: String) {
    guard let clip = clips.removeValue(forKey: id) else {
      // Still being made: said as soon as it is.
      sayNext = id
      return
    }
    sayNext = nil
    do {
      try ensureRunning()
    } catch {
      emit(["type": "error", "message": "声音播放不了：\(error.localizedDescription)"])
      emit(["type": "done", "id": id])
      return
    }
    playing = id
    let generation = self.generation
    player.scheduleBuffer(clip, at: nil, options: [], completionCallbackType: .dataPlayedBack) { _ in
      DispatchQueue.main.async { [weak self] in
        guard let self, generation == self.generation, self.playing == id else { return }
        self.playing = nil
        emit(["type": "done", "id": id])
      }
    }
    if !paused { play() }
  }
  private func play() {
    // A player started on a stopped engine brings the whole helper down.
    do {
      try ensureRunning()
    } catch {
      emit(["type": "error", "message": "声音播放不了：\(error.localizedDescription)"])
      if let id = playing {
        playing = nil
        emit(["type": "done", "id": id])
      }
      return
    }
    player.play()
  }
  private func hush() {
    generation += 1
    jobs.removeAll()
    clips.removeAll()
    sayNext = nil
    playing = nil
    if making != nil {
      making = nil
      synth.stopSpeaking(at: .immediate)
    }
    player.stop()
  }

  // MARK: the audio engine

  private func ensureRunning() throws {
    if !engine.isRunning {
      engine.prepare()
      try engine.start()
    }
  }
  // New engines, with the microphone on one only while listening: touching the input at all
  // turns the microphone on.
  private func rebuild() {
    let wasPlaying = playing
    teardown()
    makePlayer()
    if listening, let file = environment["FOLIO_SPEECH_INPUT"] {
      playIn(file)
    } else if listening {
      var failure: Error?
      // A pair of devices that couldn't share a voice processing engine before won't now.
      let devices = "\(defaultDevice(input: true))|\(defaultDevice(input: false))"
      let unshared = UserDefaults.standard.stringArray(forKey: "unshared") ?? []
      for candidate in Setup.allCases where candidate != .shared || !unshared.contains(devices) {
        do {
          try listen(with: candidate)
          setup = candidate
          failure = nil
          break
        } catch {
          log("microphone setup \(candidate.rawValue) failed: \(error)")
          if candidate == .shared {
            UserDefaults.standard.set(Array((unshared + [devices]).suffix(20)), forKey: "unshared")
          }
          failure = error
          teardown()
          makePlayer()
        }
      }
      if let failure { microphoneFailed(failure) }
    }
    // What was being said when the engine changed is cut off.
    if let id = wasPlaying {
      playing = nil
      emit(["type": "done", "id": id])
    }
  }
  // The system's default microphone or speaker, by its unique id.
  private func defaultDevice(input: Bool) -> String {
    var address = AudioObjectPropertyAddress(
      mSelector: input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice,
      mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var device = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr
    else { return "" }
    address.mSelector = kAudioDevicePropertyDeviceUID
    var uid: Unmanaged<CFString>?
    size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &uid) == noErr, let uid else { return "" }
    return uid.takeRetainedValue() as String
  }
  private func teardown() {
    engine.stop()
    micEngine?.stop()
    tapped?.inputNode.removeTap(onBus: 0)
    tapped = nil
    micEngine = nil
    recording?.cancel()
    recording = nil
  }
  // The engine that plays, with its whole graph connected before it starts: changing it while
  // it runs stops a voice processing engine.
  private func makePlayer(voiceProcessing: Bool = false) {
    engine = AVAudioEngine()
    player = AVAudioPlayerNode()
    pitch = AVAudioUnitTimePitch()
    pitch.rate = rate
    if voiceProcessing { try? process(engine) }
    engine.attach(player)
    engine.attach(pitch)
    // The time-pitch unit changes speed, not sample rate, so both its sides take one format.
    engine.connect(player, to: pitch, format: speechFormat)
    engine.connect(pitch, to: engine.mainMixerNode, format: speechFormat)
    if environment["FOLIO_SPEECH_SILENT"] != nil { engine.mainMixerNode.outputVolume = 0 }
  }
  private func process(_ e: AVAudioEngine) throws {
    try e.inputNode.setVoiceProcessingEnabled(true)
    if #available(macOS 14.0, *) {
      e.inputNode.voiceProcessingOtherAudioDuckingConfiguration = .init(
        enableAdvancedDucking: false, duckingLevel: .min)
    }
  }
  // Both engines are started here, so a setup that can't run is found out now and the next
  // one is tried, not when the teacher first speaks.
  private func listen(with setup: Setup) throws {
    switch setup {
    case .shared:
      engine.stop()
      makePlayer(voiceProcessing: true)
      guard engine.inputNode.isVoiceProcessingEnabled else { throw Failure("没有回声消除") }
      try tap(engine)
      try ensureRunning()
    case .separate, .plain:
      let mic = AVAudioEngine()
      if setup == .separate { try process(mic) }
      micEngine = mic
      try tap(mic)
      mic.prepare()
      try mic.start()
      try ensureRunning()
    }
  }
  private func tap(_ e: AVAudioEngine) throws {
    let input = e.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { throw Failure("没有找到麦克风") }
    let mono = AVAudioFormat(standardFormatWithSampleRate: format.sampleRate, channels: 1)!
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      self?.hear(buffer, mono)
    }
    tapped = e
  }
  private func microphoneFailed(_ error: Error) {
    listening = false
    teardown()
    makePlayer()
    ears?.stop()
    ears = nil
    emit(["type": "error", "message": "麦克风打不开：\(error.localizedDescription)"])
    emit(["type": "listening", "on": false])
  }
  // Headphones plugged in, the default device changed, or voice processing setting up its own
  // device: an engine has stopped. The changes come in bursts, so the engines start again once
  // they settle, with the microphone's new format. If that fails the setups are tried again
  // from the start, a couple of times.
  private var restartWork: DispatchWorkItem?
  private func configurationChanged() {
    restartWork?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.restart(tries: 3) }
    restartWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
  }
  private func restart(tries: Int) {
    let wasPlaying = playing
    do {
      tapped?.inputNode.removeTap(onBus: 0)
      tapped = nil
      if listening && environment["FOLIO_SPEECH_INPUT"] == nil {
        let listener = micEngine ?? engine
        try tap(listener)
        if !listener.isRunning {
          listener.prepare()
          try listener.start()
        }
      }
      if wasPlaying != nil || listening { try ensureRunning() }
    } catch {
      if tries > 0 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
          self?.restart(tries: tries - 1)
        }
        return
      }
      log("restart failed: \(error)")
      let now = Date()
      rebuilds = rebuilds.filter { now.timeIntervalSince($0) < 30 }
      if listening && rebuilds.count < 2 {
        rebuilds.append(now)
        return rebuild()
      }
      if listening { microphoneFailed(error) }
    }
    // The player stopped with the engine: the sentence it was saying is cut off.
    if let id = wasPlaying {
      playing = nil
      emit(["type": "done", "id": id])
    }
  }

  private func playIn(_ file: String) {
    guard let audio = try? AVAudioFile(forReading: URL(fileURLWithPath: file)),
      let all = AVAudioPCMBuffer(pcmFormat: audio.processingFormat, frameCapacity: AVAudioFrameCount(audio.length)),
      (try? audio.read(into: all)) != nil
    else { return log("can't read \(file)") }
    let rate = audio.processingFormat.sampleRate
    let mono = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
    let values = samples(all)
    let step = Int(rate / 50)
    var at = 0
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "folio.speech.recording"))
    timer.schedule(deadline: .now(), repeating: .milliseconds(20))
    timer.setEventHandler { [weak self] in
      // After the recording, the quiet of an empty room.
      let piece = at < values.count ? Array(values[at..<min(values.count, at + step)]) : [Float](repeating: 0, count: step)
      at += step
      if let buffer = pcm(piece, rate: rate) { self?.hear(buffer, mono) }
    }
    timer.resume()
    recording = timer
  }

  // MARK: listening

  private func listen(_ on: Bool) {
    starting += 1
    let attempt = starting
    ears?.stop()
    ears = nil
    resetHearing()
    if !on {
      if listening {
        listening = false
        rebuild()
      }
      emit(["type": "listening", "on": false])
      return
    }
    let locale = Locale(identifier: self.locale)
    let heard: (String) -> Void = { [weak self] text in self?.heard(text) }
    Task {
      do {
        let ears: Ears
        if #available(macOS 26.0, *), ProcessInfo.processInfo.environment["FOLIO_SPEECH_LEGACY"] == nil {
          ears = try await Analyzer.make(locale: locale, heard: heard)
        } else {
          ears = try await Recognizer.make(locale: locale, heard: heard)
        }
        DispatchQueue.main.async {
          guard attempt == self.starting else { return ears.stop() }
          self.ears = ears
          if !self.listening {
            self.listening = true
            self.rebuild()
          }
          if self.listening { emit(["type": "listening", "on": true, "setup": self.setup.rawValue]) }
        }
      } catch {
        DispatchQueue.main.async {
          guard attempt == self.starting else { return }
          emit(["type": "error", "message": error.localizedDescription])
          emit(["type": "listening", "on": false])
        }
      }
    }
  }
  // On the audio thread.
  private func hear(_ buffer: AVAudioPCMBuffer, _ mono: AVAudioFormat) {
    let values = samples(buffer)
    guard !values.isEmpty, let one = pcm(values, rate: mono.sampleRate) else { return }
    var sum: Float = 0
    for v in values { sum += v * v }
    let db = 10 * log10(Double(sum / Float(values.count)) + 1e-10)
    let ms = Double(values.count) / mono.sampleRate * 1000
    DispatchQueue.main.async { [weak self] in self?.loudness(db, ms) }
    if !muted { ears?.feed(one) }
  }
  private func loudness(_ db: Double, _ ms: Double) {
    guard listening, !muted else { return }
    let loud = db > max(noise + 12, -50)
    if loud {
      voiced += ms
      silent = 0
    } else {
      silent += ms
      voiced = max(0, voiced - ms)
      // The room's own noise: follows it down at once and up slowly.
      noise = db < noise ? db : noise + (db - noise) * min(1, ms / 3000)
    }
    if !talking && voiced >= 150 { talking = true }
    if talking && silent >= 350 { talking = false }
    let now = Date()
    if now.timeIntervalSince(lastLevel) > 0.08 {
      lastLevel = now
      emit(["type": "level", "v": max(0, min(1, (db + 60) / 50)), "talking": talking])
    }
    // The student has stopped: what they said goes to the teacher.
    let quietFor = now.timeIntervalSince(changed)
    if !text.isEmpty && !finishing && !talking && (silent >= 900 || quietFor >= 2.5) {
      finishing = true
      ears?.finish { [weak self] said in
        guard let self else { return }
        let words = said.trimmingCharacters(in: .whitespacesAndNewlines)
        self.resetHearing()
        if !words.isEmpty { emit(["type": "utterance", "text": words]) }
      }
    }
  }
  private func heard(_ text: String) {
    guard !finishing, !muted else { return }
    let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard words != self.text else { return }
    self.text = words
    changed = Date()
    emit(["type": "heard", "text": words])
  }
  private func resetHearing() {
    text = ""
    finishing = false
    changed = Date()
  }

  // MARK: checking it works without the audio devices

  // Synthesizes a sentence and runs it through the recognizer, printing what was heard.
  @available(macOS 26.0, *)
  func selftest(_ sentence: String) {
    handle(["type": "prepare", "id": "t", "text": sentence, "voice": ""])
    var ready = false
    let started = Date()
    func wait() {
      if let clip = clips["t"] {
        ready = true
        log("synthesized \(clip.frameLength) frames at \(clip.format.sampleRate) Hz in \(Int(Date().timeIntervalSince(started) * 1000)) ms")
        Task {
          let ears = try await (Analyzer.make(locale: Locale(identifier: "zh-CN")) { _ in })
          // A second of silence before and after, fed in 20 ms pieces like a microphone.
          let silence = [Float](repeating: 0, count: Int(clip.format.sampleRate))
          let all = silence + samples(clip) + silence
          let step = Int(clip.format.sampleRate / 50)
          for at in stride(from: 0, to: all.count, by: step) {
            ears.feed(pcm(Array(all[at..<min(all.count, at + step)]), rate: clip.format.sampleRate)!)
          }
          ears.finish { text in
            log("heard: \(text)")
            exit(0)
          }
        }
      } else if !ready {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: wait)
      }
    }
    wait()
  }
}

let helper = Helper()
let args = CommandLine.arguments
if args.count > 2, args[1] == "--selftest" {
  if #available(macOS 26.0, *) {
    helper.selftest(args[2])
  } else {
    log("needs macOS 26")
    exit(1)
  }
} else {
  // Commands, one JSON object per line; the helper quits when Electron closes its stdin.
  Thread.detachNewThread {
    while let line = readLine() {
      guard let data = line.data(using: .utf8),
        let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { continue }
      DispatchQueue.main.async { helper.handle(message) }
    }
    exit(0)
  }
}
// Speech assets and the synthesizer call back on the main run loop, not just the main queue.
RunLoop.main.run()
