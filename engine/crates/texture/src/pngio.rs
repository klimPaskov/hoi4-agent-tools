//! PNG decoding (any colour type, to 8-bit RGBA) and encoding (8-bit RGBA).

use crate::{DecodeError, Decoded, ErrorKind, Image, check_size};

pub fn decode(bytes: &[u8], max_pixels: u64) -> Result<Decoded, DecodeError> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| DecodeError::new(ErrorKind::Invalid, "PNG", e.to_string()))?;
    let (width, height) = (reader.info().width, reader.info().height);
    check_size(width, height, max_pixels, "PNG")?;
    let size = reader.output_buffer_size().ok_or_else(|| DecodeError::new(ErrorKind::TooLarge, "PNG", "the image is too large"))?;
    let mut buffer = vec![0; size];
    let frame = reader.next_frame(&mut buffer).map_err(|e| DecodeError::new(ErrorKind::Truncated, "PNG", e.to_string()))?;
    let data = &buffer[..frame.buffer_size()];
    let mut image = Image::new(width, height);
    let pixels = width as usize * height as usize;
    match frame.color_type {
        png::ColorType::Rgba => image.rgba.copy_from_slice(&data[..pixels * 4]),
        png::ColorType::Rgb => {
            for (out, px) in image.rgba.chunks_exact_mut(4).zip(data.chunks_exact(3)) {
                out.copy_from_slice(&[px[0], px[1], px[2], 255]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            for (out, px) in image.rgba.chunks_exact_mut(4).zip(data.chunks_exact(2)) {
                out.copy_from_slice(&[px[0], px[0], px[0], px[1]]);
            }
        }
        png::ColorType::Grayscale => {
            for (out, &grey) in image.rgba.chunks_exact_mut(4).zip(data) {
                out.copy_from_slice(&[grey, grey, grey, 255]);
            }
        }
        png::ColorType::Indexed => {
            return Err(DecodeError::new(ErrorKind::Unsupported, "PNG", "indexed PNG was not expanded"));
        }
    }
    Ok(Decoded { image, format: "PNG".to_string() })
}

/// Encodes 8-bit RGBA. `fast` trades file size for speed, for previews that are shown once.
pub fn encode(image: &Image, fast: bool) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, image.width, image.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        if fast {
            encoder.set_compression(png::Compression::Fastest);
            encoder.set_filter(png::Filter::Up);
        } else {
            encoder.set_compression(png::Compression::Balanced);
            encoder.set_filter(png::Filter::Adaptive);
        }
        // Writing to a Vec cannot fail and the header matches the buffer, so the only error left
        // is a programming error.
        let mut writer = encoder.write_header().expect("PNG header");
        writer.write_image_data(&image.rgba).expect("PNG data matches the header");
    }
    out
}
