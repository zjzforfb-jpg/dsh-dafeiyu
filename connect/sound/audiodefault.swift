// Minimal CoreAudio helper: list devices and switch the macOS default input/output.
// Build: swiftc -O connect/sound/audiodefault.swift -o runtime/sound/bin/audiodefault
import Foundation
import CoreAudio

let systemObject = AudioObjectID(kAudioObjectSystemObject)

func propAddress(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func deviceName(_ device: AudioDeviceID) -> String {
    var addr = propAddress(kAudioObjectPropertyName)
    var size = UInt32(MemoryLayout<CFString?>.size)
    var value: CFString? = nil
    let status = withUnsafeMutablePointer(to: &value) { pointer in
        AudioObjectGetPropertyData(device, &addr, 0, nil, &size, pointer)
    }
    guard status == noErr, let name = value else { return "unknown" }
    return name as String
}

func allDevices() -> [AudioDeviceID] {
    var addr = propAddress(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(systemObject, &addr, 0, nil, &size) == noErr else { return [] }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var list = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(systemObject, &addr, 0, nil, &size, &list) == noErr else { return [] }
    return list
}

func channelCount(_ device: AudioDeviceID, input: Bool) -> Int {
    var addr = propAddress(kAudioDevicePropertyStreamConfiguration, input ? kAudioObjectPropertyScopeInput : kAudioObjectPropertyScopeOutput)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(device, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, raw) == noErr else { return 0 }
    let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioDeviceID {
    var addr = propAddress(selector)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var device = AudioDeviceID(0)
    _ = AudioObjectGetPropertyData(systemObject, &addr, 0, nil, &size, &device)
    return device
}

func setDefaultDevice(_ selector: AudioObjectPropertySelector, _ device: AudioDeviceID) -> Bool {
    var addr = propAddress(selector)
    var value = device
    return AudioObjectSetPropertyData(systemObject, &addr, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &value) == noErr
}

func find(_ name: String, input: Bool) -> AudioDeviceID? {
    let match = allDevices().first { device in
        let channels = channelCount(device, input: input)
        return channels > 0 && deviceName(device).lowercased().contains(name.lowercased())
    }
    return match
}

let args = Array(CommandLine.arguments.dropFirst())
let selectorInput = kAudioHardwarePropertyDefaultInputDevice
let selectorOutput = kAudioHardwarePropertyDefaultOutputDevice

switch args.first {
case "list":
    for device in allDevices() {
        let input = channelCount(device, input: true)
        let output = channelCount(device, input: false)
        if input == 0 && output == 0 { continue }
        print("\(device)\t\(deviceName(device))\t\(input)\t\(output)")
    }
case "get":
    guard args.count >= 2 else { FileHandle.standardError.write("usage: get input|output\n".data(using: .utf8)!); exit(2) }
    let selector = args[1] == "input" ? selectorInput : selectorOutput
    print(deviceName(defaultDevice(selector)))
case "set":
    guard args.count >= 3 else { FileHandle.standardError.write("usage: set input|output Name\n".data(using: .utf8)!); exit(2) }
    let input = args[1] == "input"
    guard let device = find(args[2], input: input) else {
        FileHandle.standardError.write("device not found: \(args[2])\n".data(using: .utf8)!)
        exit(1)
    }
    let selector = input ? selectorInput : selectorOutput
    if !setDefaultDevice(selector, device) {
        FileHandle.standardError.write("failed to switch default device\n".data(using: .utf8)!)
        exit(1)
    }
    print("\(args[1]) -> \(deviceName(device))")
default:
    print("usage: audiodefault list | get input|output | set input|output Name")
}
