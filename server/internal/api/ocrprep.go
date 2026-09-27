package api

import (
	"image"
	"image/color"
	_ "image/gif" // decoders for uploaded images
	_ "image/jpeg"
	"image/png"
	"io"
	"os"
	"sort"
)

// Preprocessing for OCR on hand drawings and images of notes.
//
// Tesseract is trained on print: opaque background, dark glyphs roughly
// 20-60 px tall whose strokes are about 1/8 of the letter height. Canvas
// drawings break all of it: a transparent raster layer, ink occupying a small
// part of a large page, letters hundreds of pixels tall drawn with a brush
// that is thin relative to them. The pipeline (tuned on real canvas exports,
// see testdata/) is:
//
//  1. composite over white, convert to grayscale;
//  2. crop to the ink bounding box with a margin;
//  3. estimate the text line height (horizontal projection bands) and the
//     current stroke width (median horizontal ink run);
//  4. thicken strokes towards lineHeight/TargetStrokeRatio (separable min
//     filter) when they are much thinner than print;
//  5. box-downscale so a text line is about TargetLineHeight px;
//  6. binarise.
//
// Images that already look like print (photos, screenshots) pass through
// steps 4-5 unchanged.

const (
	TargetLineHeight  = 56
	TargetStrokeRatio = 8
	inkThreshold      = 160
)

// PrepareForOCR reads an image file and writes a normalised PNG to dst.
// It returns false when the image contains no ink at all (a blank canvas).
func PrepareForOCR(src string, dst io.Writer) (bool, error) {
	f, err := os.Open(src)
	if err != nil {
		return false, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return false, err
	}
	g := flattenGray(img)
	box, ok := inkBounds(g)
	if !ok {
		return false, nil
	}
	lineH := medianLineHeight(g, box)
	margin := max(20, lineH/2)
	g = cropPad(g, box, margin)

	stroke := medianRun(g)
	want := max(1, lineH/TargetStrokeRatio)
	if stroke*3/2 < want { // clearly thinner than print: thicken
		g = minFilter(g, min((want-stroke)/2, 40))
	}
	factor := max(1, lineH/TargetLineHeight)
	g = boxDownscale(g, factor)
	for i, v := range g.Pix {
		if v < inkThreshold {
			g.Pix[i] = 0
		} else {
			g.Pix[i] = 255
		}
	}
	return true, png.Encode(dst, g)
}

// flattenGray composites the image over white and converts to 8-bit gray.
func flattenGray(img image.Image) *image.Gray {
	b := img.Bounds()
	g := image.NewGray(image.Rect(0, 0, b.Dx(), b.Dy()))
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, gg, bb, a := img.At(x, y).RGBA() // premultiplied 16-bit
			inv := 0xffff - a                   // over white
			lum := (299*(r+inv) + 587*(gg+inv) + 114*(bb+inv)) / 1000
			g.Pix[(y-b.Min.Y)*g.Stride+(x-b.Min.X)] = uint8(lum >> 8)
		}
	}
	return g
}

// inkBounds returns the bounding box of dark pixels.
func inkBounds(g *image.Gray) (image.Rectangle, bool) {
	w, h := g.Rect.Dx(), g.Rect.Dy()
	minX, minY, maxX, maxY := w, h, -1, -1
	for y := 0; y < h; y++ {
		for x, v := range g.Pix[y*g.Stride : y*g.Stride+w] {
			if v < inkThreshold {
				minX, maxX = min(minX, x), max(maxX, x)
				minY, maxY = min(minY, y), max(maxY, y)
			}
		}
	}
	if maxX < 0 {
		return image.Rectangle{}, false
	}
	return image.Rect(minX, minY, maxX+1, maxY+1), true
}

// medianLineHeight splits the ink box into horizontal bands separated by
// blank rows and returns the median band height (the text line height).
func medianLineHeight(g *image.Gray, box image.Rectangle) int {
	var bands []int
	start := -1
	for y := box.Min.Y; y <= box.Max.Y; y++ {
		ink := false
		if y < box.Max.Y {
			for _, v := range g.Pix[y*g.Stride+box.Min.X : y*g.Stride+box.Max.X] {
				if v < inkThreshold {
					ink = true
					break
				}
			}
		}
		switch {
		case ink && start < 0:
			start = y
		case !ink && start >= 0:
			if y-start >= 4 { // ignore specks
				bands = append(bands, y-start)
			}
			start = -1
		}
	}
	if len(bands) == 0 {
		return box.Dy()
	}
	sort.Ints(bands)
	return bands[len(bands)/2]
}

// medianRun is the median length of horizontal ink runs (~ stroke width).
func medianRun(g *image.Gray) int {
	var runs []int
	w, h := g.Rect.Dx(), g.Rect.Dy()
	for y := 0; y < h; y += 2 {
		run := 0
		for x := 0; x <= w; x++ {
			if x < w && g.Pix[y*g.Stride+x] < inkThreshold {
				run++
			} else if run > 0 {
				runs = append(runs, run)
				run = 0
			}
		}
	}
	if len(runs) == 0 {
		return 1
	}
	sort.Ints(runs)
	return runs[len(runs)/2]
}

func cropPad(g *image.Gray, box image.Rectangle, m int) *image.Gray {
	out := image.NewGray(image.Rect(0, 0, box.Dx()+2*m, box.Dy()+2*m))
	for i := range out.Pix {
		out.Pix[i] = 255
	}
	for y := box.Min.Y; y < box.Max.Y; y++ {
		copy(out.Pix[(y-box.Min.Y+m)*out.Stride+m:], g.Pix[y*g.Stride+box.Min.X:y*g.Stride+box.Max.X])
	}
	return out
}

// minFilter darkens each pixel to the minimum of its (2r+1)^2 neighbourhood,
// done separably (rows, then columns) so the cost is O(pixels * r).
func minFilter(g *image.Gray, r int) *image.Gray {
	if r <= 0 {
		return g
	}
	w, h := g.Rect.Dx(), g.Rect.Dy()
	tmp := image.NewGray(g.Rect)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			m := uint8(255)
			for k := max(0, x-r); k <= min(w-1, x+r); k++ {
				m = min(m, g.Pix[y*g.Stride+k])
			}
			tmp.Pix[y*tmp.Stride+x] = m
		}
	}
	out := image.NewGray(g.Rect)
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			m := uint8(255)
			for k := max(0, y-r); k <= min(h-1, y+r); k++ {
				m = min(m, tmp.Pix[k*tmp.Stride+x])
			}
			out.Pix[y*out.Stride+x] = m
		}
	}
	return out
}

func boxDownscale(g *image.Gray, f int) *image.Gray {
	if f <= 1 {
		return g
	}
	w, h := g.Rect.Dx(), g.Rect.Dy()
	out := image.NewGray(image.Rect(0, 0, (w+f-1)/f, (h+f-1)/f))
	for oy := 0; oy < out.Rect.Dy(); oy++ {
		for ox := 0; ox < out.Rect.Dx(); ox++ {
			sum, n := 0, 0
			for y := oy * f; y < min(h, oy*f+f); y++ {
				for x := ox * f; x < min(w, ox*f+f); x++ {
					sum += int(g.Pix[y*g.Stride+x])
					n++
				}
			}
			out.SetGray(ox, oy, color.Gray{Y: uint8(sum / n)})
		}
	}
	return out
}
