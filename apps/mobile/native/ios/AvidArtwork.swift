import CryptoKit
import Foundation
import ImageIO
import UIKit

/// Artwork transport is credential-isolated, bounded before decoding, and cached as small image bytes.
/// Neither object URLs nor authenticated cover URLs are persisted.
@MainActor
enum AvidArtwork {
    private static let inputLimit = 2 * 1024 * 1024
    private static let imageLimit = 96 * 1024
    private static let imageCount = 64
    private static func path(scope: String, book: String, file: String) throws -> URL {
        let root = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("AvidArtwork", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let key = SHA256.hash(data: Data("\(scope)\u{0}\(book)\u{0}\(file)".utf8)).map { String(format: "%02x", $0) }.joined()
        return root.appendingPathComponent("\(AvidSharedStore.scopeHash(scope))-\(key).jpg")
    }
    static func removeAccount(scopeHash: String) {
        guard scopeHash.count == 64, scopeHash.allSatisfy({ $0.isHexDigit }),
              let root = try? FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: false).appendingPathComponent("AvidArtwork", isDirectory: true),
              let files = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return }
        for file in files where file.lastPathComponent.hasPrefix(scopeHash + "-") { try? FileManager.default.removeItem(at: file) }
    }
    static func cached(scope: String, book: String, file: String) -> UIImage? {
        guard let url = try? path(scope: scope, book: book, file: file),
              let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue,
              size > 0, size <= imageLimit, let bytes = try? Data(contentsOf: url) else { return nil }
        return UIImage(data: bytes)
    }
    static func load(raw: String?, scope: String, book: String, file: String) async -> UIImage? {
        guard let raw, !raw.isEmpty else { return cached(scope: scope, book: book, file: file) }
        do {
            let data: Data
            if raw.hasPrefix("data:image/") {
                guard raw.utf8.count <= 4 * ((inputLimit + 2) / 3) + 64,
                      let separator = raw.firstIndex(of: ","),
                      ["data:image/jpeg;base64", "data:image/png;base64", "data:image/webp;base64"].contains(String(raw[..<separator])),
                      let decoded = Data(base64Encoded: String(raw[raw.index(after: separator)...])), decoded.count <= inputLimit else { return nil }
                data = decoded
            } else {
                guard let url = URL(string: raw), ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil, url.user == nil, url.password == nil else { return nil }
                let config = URLSessionConfiguration.ephemeral
                config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCredentialStorage = nil; config.urlCache = nil
                config.timeoutIntervalForRequest = 20
                let session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
                defer { session.invalidateAndCancel() }
                var request = URLRequest(url: url)
                // Only cookies from the verified server scope may accompany a protected cover request.
                if AvidAuthCoordinator.protects(scope: scope, url: url) {
                    request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: HTTPCookieStorage.shared.cookies(for: url) ?? [])
                }
                let (stream, response) = try await session.bytes(for: request)
                guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                      response.expectedContentLength <= Int64(inputLimit) else { return nil }
                var value = Data()
                for try await byte in stream {
                    try Task.checkCancellation()
                    guard value.count < inputLimit else { return nil }
                    value.append(byte)
                }
                data = value
            }
            try Task.checkCancellation()
            guard !data.isEmpty, let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                      kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 384,
                      kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else { return nil }
            let thumbnail = UIImage(cgImage: image)
            if let encoded = thumbnail.jpegData(compressionQuality: 0.75), encoded.count <= imageLimit {
                try Task.checkCancellation()
                let target = try path(scope: scope, book: book, file: file)
                try encoded.write(to: target, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                let files = try FileManager.default.contentsOfDirectory(at: target.deletingLastPathComponent(), includingPropertiesForKeys: [.contentModificationDateKey])
                let oldest = files.sorted { ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast) < ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast) }
                for old in oldest.prefix(max(0, oldest.count - imageCount)) { try? FileManager.default.removeItem(at: old) }
            }
            return thumbnail
        } catch { return nil }
    }
    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    }
}
