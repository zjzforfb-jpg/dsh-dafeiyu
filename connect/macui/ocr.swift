import Cocoa
import Vision

// Usage: ocr <window_id>  — capture the window and print recognized text lines.
guard CommandLine.arguments.count > 1, let wid = UInt32(CommandLine.arguments[1]) else { print("usage: ocr <window_id>"); exit(1) }
let task = Process()
task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
task.arguments = ["-o", "-x", "-l", String(wid), "/tmp/dsh-ocr.png"]
try? task.run(); task.waitUntilExit()
guard let image = NSImage(contentsOfFile: "/tmp/dsh-ocr.png"),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { print("no_image"); exit(1) }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try? handler.perform([request])
for observation in request.results ?? [] {
  if let candidate = observation.topCandidates(1).first { print(candidate.string) }
}
