// MacAssistant: optional native helper for the coaching backend (speech synthesis + Foundation Models).
// Listens on 127.0.0.1 only; every request needs the bearer token from --token-file (0600).
//
//   swift run MacAssistant --check                       print availability (no server, no audio)
//   swift run MacAssistant --token-file <path> [--port 8766] [--silent]
import CoachAssistantKit
import Foundation

struct Options {
    var port: UInt16 = 8766
    var tokenFile = FileManager.default.currentDirectoryPath + "/assistant_token"
    var check = false
    var silent = false
}

func parseOptions() -> Options {
    var options = Options()
    var args = CommandLine.arguments.dropFirst()
    while let arg = args.popFirst() {
        switch arg {
        case "--check": options.check = true
        case "--silent": options.silent = true
        case "--port": options.port = UInt16(args.popFirst() ?? "") ?? options.port
        case "--token-file": options.tokenFile = args.popFirst() ?? options.tokenFile
        default:
            FileHandle.standardError.write(Data("unknown argument \(arg)\n".utf8))
            exit(2)
        }
    }
    return options
}

let options = parseOptions()
if options.check {
    let status = AssistantStatus.current()
    let data = try JSONEncoder.pretty.encode(status)
    print(String(decoding: data, as: UTF8.self))
    exit(0)
}

do {
    let token = try TokenFile.loadOrCreate(path: options.tokenFile)
    let server = AssistantServer(port: options.port, token: token, silent: options.silent)
    try server.start()
    LanguageModelService.prewarm()
    print("MacAssistant listening on http://127.0.0.1:\(options.port) (token file: \(options.tokenFile))")
    dispatchMain()
} catch {
    FileHandle.standardError.write(Data("MacAssistant failed: \(error)\n".utf8))
    exit(1)
}
