//! System controls receive only decoded, resized local artwork, never a server URL or data URI.
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, ImageDecoder, ImageFormat,
    ImageReader, Limits,
};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::{self, Cursor, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_PIXELS: u64 = 16 * 1024 * 1024;
const MAX_DECODE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DIMENSION: u32 = 8192;
const OUTPUT_DIMENSION: u32 = 512;
const CACHE_FILES: usize = 8;
const INVALID: &str = "The cover image is invalid or exceeds native artwork limits.";
const UNAVAILABLE: &str = "The private artwork cache is unavailable.";
type Result<T> = std::result::Result<T, String>;

pub struct ArtworkCache {
    directory: PathBuf,
    scope: Option<String>,
    recent: VecDeque<String>,
}
impl ArtworkCache {
    /// Pass app_data_dir()/private-artwork. Startup discards account artwork left by a crash.
    pub fn new(directory: PathBuf) -> Result<Self> {
        private_directory(&directory)?;
        let mut cache = Self {
            directory,
            scope: None,
            recent: VecDeque::new(),
        };
        cache.clear()?;
        Ok(cache)
    }
    pub fn prepare(
        &mut self,
        scope: &str,
        book_id: &str,
        file_id: &str,
        data_url: &str,
    ) -> Result<String> {
        validate_identity(scope, book_id, file_id)?;
        if self.scope.as_deref() != Some(scope) {
            self.clear()?;
            self.scope = Some(scope.into());
        }
        if data_url.len() > MAX_INPUT_BYTES.div_ceil(3) * 4 + 32 {
            return Err(INVALID.into());
        }
        let identity = serde_json::to_vec(&[scope, book_id, file_id]).map_err(|_| INVALID)?;
        let mut digest = Sha256::new();
        digest.update(identity);
        digest.update([0]);
        digest.update(data_url.as_bytes());
        let key = format!("{:x}", digest.finalize());
        let path = self.directory.join(format!("{key}.jpg"));
        if !valid_existing(&path)? {
            let bytes = sanitize(data_url)?;
            self.write_image(&path, &bytes)?;
        }
        self.recent.retain(|prior| prior != &key);
        self.recent.push_back(key);
        while self.recent.len() > CACHE_FILES {
            let old = self.recent.pop_front().ok_or(UNAVAILABLE)?;
            remove_owned(&self.directory.join(format!("{old}.jpg")))?;
        }
        souvlaki_file_url(&path, cfg!(windows))
    }
    /// Souvlaki's Windows backend leaves old thumbnails intact when cover_url is None.
    /// Publish this neutral local image to explicitly replace an absent/cleared cover.
    pub fn empty(&mut self) -> Result<String> {
        let path = self.directory.join("empty.jpg");
        if !valid_existing(&path)? {
            let pixels = image::RgbImage::from_pixel(1, 1, image::Rgb([232, 232, 232]));
            self.write_image(&path, &encode(&pixels, 82)?)?;
        }
        souvlaki_file_url(&path, cfg!(windows))
    }
    pub fn clear(&mut self) -> Result<()> {
        self.scope = None;
        self.recent.clear();
        for entry in fs::read_dir(&self.directory).map_err(|_| UNAVAILABLE)? {
            let path = entry.map_err(|_| UNAVAILABLE)?.path();
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default();
            let owned = name == "empty.jpg"
                || (path.extension().and_then(|s| s.to_str()) == Some("jpg")
                    && stem.len() == 64
                    && stem.bytes().all(|b| b.is_ascii_hexdigit()))
                || (path.extension().and_then(|s| s.to_str()) == Some("tmp")
                    && Uuid::parse_str(stem).is_ok());
            if owned {
                remove_owned(&path)?;
            }
        }
        Ok(())
    }
    fn write_image(&self, target: &Path, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() || bytes.len() > MAX_OUTPUT_BYTES {
            return Err(INVALID.into());
        }
        let temporary = self.directory.join(format!("{}.tmp", Uuid::new_v4()));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary).map_err(|_| UNAVAILABLE)?;
            file.write_all(bytes).map_err(|_| UNAVAILABLE)?;
            file.sync_all().map_err(|_| UNAVAILABLE)?;
            drop(file);
            fs::rename(&temporary, target).map_err(|_| UNAVAILABLE)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
}
fn validate_identity(scope: &str, book: &str, file: &str) -> Result<()> {
    if scope.len() > 32 * 1024
        || book.trim().is_empty()
        || file.trim().is_empty()
        || book.len() > 8192
        || file.len() > 8192
        || book.chars().chain(file.chars()).any(char::is_control)
    {
        return Err(INVALID.into());
    }
    let pair: Vec<String> = serde_json::from_str(scope).map_err(|_| INVALID)?;
    if pair.len() != 2
        || pair[1].trim().is_empty()
        || pair[1].chars().any(char::is_control)
        || crate::vault::normalize_server_url(&pair[0]).map_err(|_| INVALID)? != pair[0]
        || serde_json::to_string(&pair).map_err(|_| INVALID)? != scope
    {
        return Err(INVALID.into());
    }
    Ok(())
}
fn sanitize(data_url: &str) -> Result<Vec<u8>> {
    let (prefix, encoded) = data_url.split_once(',').ok_or(INVALID)?;
    let format = match prefix {
        "data:image/jpeg;base64" => ImageFormat::Jpeg,
        "data:image/png;base64" => ImageFormat::Png,
        "data:image/webp;base64" => ImageFormat::WebP,
        _ => return Err(INVALID.into()),
    };
    if encoded.len() > MAX_INPUT_BYTES.div_ceil(3) * 4 {
        return Err(INVALID.into());
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| INVALID)?;
    if bytes.is_empty()
        || bytes.len() > MAX_INPUT_BYTES
        || image::guess_format(&bytes).map_err(|_| INVALID)? != format
    {
        return Err(INVALID.into());
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|_| INVALID)?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || u64::from(width) * u64::from(height) > MAX_PIXELS
        || decoder.total_bytes() > MAX_DECODE_BYTES
    {
        return Err(INVALID.into());
    }
    let orientation = decoder.orientation().map_err(|_| INVALID)?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|_| INVALID)?;
    image.apply_orientation(orientation);
    let rgba = image
        .resize(OUTPUT_DIMENSION, OUTPUT_DIMENSION, FilterType::Triangle)
        .to_rgba8();
    // JPEG strips source metadata; flatten transparency onto a neutral background explicitly.
    let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
    for (source, destination) in rgba.pixels().zip(rgb.pixels_mut()) {
        let alpha = u32::from(source[3]);
        for channel in 0..3 {
            destination[channel] =
                ((u32::from(source[channel]) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
        }
    }
    encode(&rgb, 82).or_else(|_| encode(&rgb, 60))
}
struct LimitedBytes(Vec<u8>);
impl Write for LimitedBytes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_OUTPUT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Artwork output exceeds its limit.",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn encode(image: &image::RgbImage, quality: u8) -> Result<Vec<u8>> {
    let mut output = LimitedBytes(Vec::new());
    JpegEncoder::new_with_quality(&mut output, quality)
        .encode(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|_| INVALID)?;
    Ok(output.0)
}
fn souvlaki_file_url(path: &Path, windows: bool) -> Result<String> {
    if windows {
        // Souvlaki 0.8.3 strips file:// and passes the remaining string directly to WinRT.
        let value = path
            .to_str()
            .filter(|value| !value.contains('\0'))
            .ok_or(UNAVAILABLE)?;
        Ok(format!("file://{value}"))
    } else {
        url::Url::from_file_path(path)
            .map(|url| url.to_string())
            .map_err(|_| UNAVAILABLE.into())
    }
}
fn private_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .map_err(|_| UNAVAILABLE)?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(path).map_err(|_| UNAVAILABLE)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| UNAVAILABLE)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(UNAVAILABLE.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| UNAVAILABLE)?;
    }
    Ok(())
}
fn valid_existing(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(UNAVAILABLE.into()),
        Ok(metadata) => {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() == 0
                || metadata.len() > MAX_OUTPUT_BYTES as u64
            {
                return Err(UNAVAILABLE.into());
            }
            Ok(true)
        }
    }
}
fn remove_owned(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(UNAVAILABLE.into()),
        Ok(metadata) => {
            // Removing an owned symlink is safe; never follow it to another file.
            if !metadata.is_file() && !metadata.file_type().is_symlink() {
                return Err(UNAVAILABLE.into());
            }
            fs::remove_file(path).map_err(|_| UNAVAILABLE.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("avid-artwork-test-{}", Uuid::new_v4())))
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn scope(user: &str) -> String {
        serde_json::to_string(&["https://library.example", user]).unwrap()
    }
    fn png(width: u32, height: u32) -> String {
        let image = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            width,
            height,
            image::Rgba([35, 90, 190, 120]),
        ));
        let mut encoded = Cursor::new(Vec::new());
        image.write_to(&mut encoded, ImageFormat::Png).unwrap();
        format!(
            "data:image/png;base64,{}",
            STANDARD.encode(encoded.into_inner())
        )
    }
    #[test]
    fn artwork_is_resized_reencoded_and_never_exposes_original_urls() {
        let directory = Directory::new();
        let mut cache = ArtworkCache::new(directory.0.clone()).unwrap();
        let source = png(1024, 768);
        let url = cache.prepare(&scope("a"), "book", "file", &source).unwrap();
        assert!(url.starts_with("file://"));
        assert!(!url.contains("library.example"));
        assert!(!url.contains("book"));
        assert_eq!(
            cache.prepare(&scope("a"), "book", "file", &source).unwrap(),
            url
        );
        let path = directory
            .0
            .join(format!("{}.jpg", cache.recent.front().unwrap()));
        let bytes = fs::read(path).unwrap();
        assert!(bytes.len() <= MAX_OUTPUT_BYTES);
        assert_eq!(image::guess_format(&bytes).unwrap(), ImageFormat::Jpeg);
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (512, 384));
        assert!(!bytes.windows(4).any(|window| window == b"Exif"));
    }
    #[test]
    fn untrusted_formats_size_mismatches_and_dimension_bombs_are_rejected() {
        for value in [
            "https://library.example/cover.jpg",
            "file:///secret",
            "data:image/svg+xml;base64,PHN2Zz4=",
            "data:image/png;base64,!!!",
        ] {
            assert!(sanitize(value).is_err());
        }
        let correct = png(1, 1);
        assert!(sanitize(&correct.replacen("image/png", "image/jpeg", 1)).is_err());
        let oversized = format!(
            "data:image/png;base64,{}",
            "A".repeat(MAX_INPUT_BYTES.div_ceil(3) * 4 + 1)
        );
        assert!(sanitize(&oversized).is_err());
        assert!(sanitize(&png(MAX_DIMENSION + 1, 1)).is_err());
    }
    #[test]
    fn cache_has_fixed_capacity_and_clears_scope_and_crash_residue() {
        let directory = Directory::new();
        let mut cache = ArtworkCache::new(directory.0.clone()).unwrap();
        let source = png(2, 2);
        for i in 0..12 {
            cache
                .prepare(&scope("a"), &format!("book-{i}"), "file", &source)
                .unwrap();
        }
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), CACHE_FILES);
        let old: Vec<_> = fs::read_dir(&directory.0)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        cache.prepare(&scope("b"), "book", "file", &source).unwrap();
        assert!(old.iter().all(|path| !path.exists()));
        cache.empty().unwrap();
        cache.clear().unwrap();
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
        cache.prepare(&scope("b"), "book", "file", &source).unwrap();
        drop(cache);
        let _reopened = ArtworkCache::new(directory.0.clone()).unwrap();
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
    }
    #[test]
    fn platform_paths_preserve_windows_spaces_and_encode_unix_urls() {
        assert_eq!(
            souvlaki_file_url(Path::new(r"C:\Users\Reading Name\cover #1.jpg"), true).unwrap(),
            r"file://C:\Users\Reading Name\cover #1.jpg"
        );
        #[cfg(unix)]
        assert_eq!(
            souvlaki_file_url(Path::new("/tmp/Reading Name/cover #1.jpg"), false).unwrap(),
            "file:///tmp/Reading%20Name/cover%20%231.jpg"
        );
    }
    #[cfg(unix)]
    #[test]
    fn cache_is_private_and_does_not_follow_cached_symlinks() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = Directory::new();
        let mut cache = ArtworkCache::new(directory.0.clone()).unwrap();
        let source = png(2, 2);
        cache.prepare(&scope("a"), "book", "file", &source).unwrap();
        let path = directory
            .0
            .join(format!("{}.jpg", cache.recent.front().unwrap()));
        assert_eq!(
            fs::metadata(&directory.0).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_file(&path).unwrap();
        symlink("/does/not/exist", &path).unwrap();
        assert!(cache.prepare(&scope("a"), "book", "file", &source).is_err());
        cache.clear().unwrap();
        assert!(!path.symlink_metadata().is_ok());
    }
}
