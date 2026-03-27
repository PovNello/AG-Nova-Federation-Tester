# AG Nova Brand Identity & UI System

This document outlines the visual identity and design tokens for the **AG Nova Federation Tester**.

## 🎨 Color Palette
Extracted from the AG Nova brand logo and implemented via CSS variables.

| Variable | Value | Usage |
| :--- | :--- | :--- |
| `--accent` | `#df7b35` | Warm Orange - Primary CTA, brand highlights. |
| `--accent-dark` | `#c26825` | Darker Orange - Hover states for primary buttons. |
| `--teal` | `#7faea8` | Sage Teal - Secondary accent, success badges. |
| `--teal-dark` | `#5f8f89` | Darker Teal - Hover states for secondary elements. |
| `--cream` | `#e8e3d8` | Logo Cream - Background highlights (Light Mode). |

### Environment Backgrounds
- **Dark Mode**: `--bg: #0a0f19` (Deep Blue), `--surface: #111827` (Slate).
- **Light Mode**: `--bg: #f5f5f4` (Light Stone), `--surface: #ffffff` (White).

## 🔠 Typography
- **Font Family**: `'IBM Plex Mono', monospace` (via Google Fonts).
- **Style**: Monospace reinforces the "developer tool" and "technical tester" aesthetic.
- **Line Height**: `1.6` for readability.

## 📐 UI Principles (Flat & Angular)
The design prioritizes a professional, technical look inspired by legacy terminal systems and modern minimalism:
- **Centralized Components**: The Header (`.navbar`) and Footer (`.footer`) are dynamically injected via `shared.js`.
- **Square Edges**: Minimal `border-radius: 4px` on cards and `0` on buttons/inputs.
- **Card Isolation**: Individual tiles with 1px borders, subtle shadows, and a top-border accent on hover.
- **Dynamic Feedback**: Hover effects use `var(--accent)` border highlights and an animated top-bar.
- **Responsive Grid**: Homepage tiles use a flexible grid (`repeat(auto-fill, minmax(280px, 1fr))` with `1.5rem` gap).

## 📄 Footer & Copyright
The standard footer for all pages (injected via `shared.js`) is:
- **Format**: `&copy; 2026 - AG Nova Industries - <a href="https://agnovaindustries.com" target="_blank">agnovaindustries.com</a>`
- **Styling**: `inherit` color for the link (or standard brand teal for visibility), no underline unless hovered.

## 🖼️ Assets
Located in `/public/assets/`:
- **Logo**: `agnovalogonotext.png` (Navbar brand).
- **Favicon**: `fav.png`.
- **Protocol Icons**: `oidcicon.png` (OIDC), `samlicon.png` (SAML).
