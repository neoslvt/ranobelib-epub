import os
import re
import time
import requests
from bs4 import BeautifulSoup
from ebooklib import epub

HEADERS = {
    'Referer': 'https://ranobelib.me/',
    'Site-Id': '3',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    'Client-Time-Zone': 'Asia/Almaty',
    'sec-ch-ua-platform': '"Linux"',
    'sec-ch-ua': '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"',
    'sec-ch-ua-mobile': '?0',
}

session = requests.Session()
session.headers.update(HEADERS)


def extract_slug(link_or_slug):
    match = re.search(r'([0-9]+--[a-zA-Z0-9-]+)', link_or_slug)
    if match:
        return match.group(1)
    return link_or_slug.strip().strip('/')


def fetch_all_chapters(slug):
    url = f"https://api.cdnlibs.org/api/manga/{slug}/chapters"
    print(f"Fetching chapter list...")
    resp = session.get(url)
    resp.raise_for_status()
    return resp.json().get("data", [])


def fetch_chapter_content(slug, volume, number, branch_id):
    url = f"https://api.cdnlibs.org/api/manga/{slug}/chapter"
    params = {'volume': volume, 'number': number, 'branch_id': branch_id}
    resp = session.get(url, params=params)
    if resp.status_code == 200:
        return resp.json().get("data", {})
    return None


def process_images(html_content, book, img_counter):
    soup = BeautifulSoup(html_content, 'html.parser')
    images = soup.find_all('img')
    
    for img in images:
        img_url = img.get('src') or img.get('data-src')
        if not img_url:
            continue
            
        if img_url.startswith('//'):
            img_url = 'https:' + img_url
            
        try:
            resp = session.get(img_url, timeout=10)
            if resp.status_code == 200:
                ext = img_url.split('.')[-1].split('?')[0].lower()
                if ext not in ['jpg', 'jpeg', 'png', 'gif', 'webp']:
                    ext = 'jpg'
                    
                mime_type = f"image/{'jpeg' if ext in ['jpg', 'jpeg'] else ext}"
                internal_name = f"images/img_{img_counter[0]}.{ext}"
                
                # Register image in EPUB
                epub_img = epub.EpubItem(
                    uid=f"img_{img_counter[0]}",
                    file_name=internal_name,
                    media_type=mime_type,
                    content=resp.content
                )
                book.add_item(epub_img)
                
                # Update tag attributes
                img['src'] = internal_name
                for attr in ['data-src', 'srcset', 'class', 'width', 'height', 'style']:
                    if attr in img.attrs:
                        del img[attr]
                
                # Isolate image into its own page-breaking container
                wrapper = soup.new_tag('div', **{'class': 'image-page-wrapper'})
                
                parent = img.parent
                # If image is inside a paragraph, extract it to prevent layout issues
                if parent and parent.name == 'p':
                    # If paragraph only contains the image (no text), replace it entirely
                    if not parent.get_text(strip=True):
                        parent.insert_before(wrapper)
                        wrapper.append(img)
                        parent.decompose()
                    else:
                        img.extract()
                        parent.insert_after(wrapper)
                        wrapper.append(img)
                else:
                    img.wrap(wrapper)
                
                img_counter[0] += 1
        except Exception as e:
            print(f"    [!] Failed to download image {img_url}: {e}")
            
    return str(soup)


def main():
    print("=== Ranobe Downloader ===\n")
    
    raw_input = input("Enter Ranobe Link or Slug:\n> ").strip()
    slug = extract_slug(raw_input)
    if not slug:
        print("Invalid input.")
        return

    all_chapters = fetch_all_chapters(slug)
    if not all_chapters:
        print("No chapters found for this title.")
        return

    volumes = sorted(list({int(c.get("volume")) for c in all_chapters if str(c.get("volume", "")).isdigit()}))
    
    unique_branches = {}
    for ch in all_chapters:
        for b in ch.get("branches", []):
            b_id = b.get("branch_id")
            if b_id not in unique_branches:
                team_names = ", ".join([t.get("name", "") for t in b.get("teams", []) if t.get("name")])
                unique_branches[b_id] = team_names or f"Branch {b_id}"

    print(f"\nFound {len(all_chapters)} total chapters across Volumes {min(volumes)} to {max(volumes)}.")
    
    print("\nAvailable Translations:")
    branch_list = list(unique_branches.items())
    for idx, (b_id, name) in enumerate(branch_list, 1):
        print(f"  [{idx}] {name}")
    
    while True:
        try:
            sel = int(input("\nSelect a translation (enter number):\n> "))
            if 1 <= sel <= len(branch_list):
                pref_branch_id = branch_list[sel-1][0]
                pref_team_name = branch_list[sel-1][1]
                print(f"Selected: {pref_team_name}")
                break
            else:
                print("Invalid number. Try again.")
        except ValueError:
            print("Please enter a valid number.")

    vol_input = input(f"\nEnter Volume to download (available: {min(volumes)}-{max(volumes)}) or type 'all':\n> ").strip().lower()
    
    selected_chapters = []
    if vol_input == 'all':
        selected_chapters = all_chapters
        vol_label = "All_Volumes"
    else:
        try:
            target_vol = int(vol_input)
            selected_chapters = [ch for ch in all_chapters if str(ch.get("volume")) == str(target_vol)]
            vol_label = f"Vol_{target_vol}"
        except ValueError:
            print("Invalid volume entered. Exiting.")
            return

    if not selected_chapters:
        print(f"No chapters found for Volume {vol_input}.")
        return

    selected_chapters.sort(
        key=lambda x: (
            float(x.get("volume", 0)) if str(x.get("volume", "")).isdigit() else 0,
            float(x.get("number", 0)) if str(x.get("number", "")).replace('.', '', 1).isdigit() else 0
        )
    )

    title_clean = slug.split('--')[-1].replace('-', ' ').title()
    book_title = f"{title_clean} - {vol_label.replace('_', ' ')}"
    output_filename = f"{slug.split('--')[-1]}_{vol_label}.epub"

    book = epub.EpubBook()
    book.set_identifier(f"ranobe-{slug}-{vol_label}")
    book.set_title(book_title)
    book.set_language('ru')

    # 1. ADD STYLESHEET
    css_content = """
    @namespace epub "http://www.idpf.org/2007/ops";
    body { 
        font-family: "Georgia", "Times New Roman", serif; 
        line-height: 1.6; 
        color: #000;
        margin: 0;
        padding: 2%;
    }
    .title-page {
        text-align: center;
        margin-top: 30vh;
    }
    .title-page h1 { font-size: 2em; margin-bottom: 0.2em; }
    .title-page h3 { font-size: 1.2em; color: #555; font-weight: normal; }
    h2.chapter-title {
        text-align: center;
        font-size: 1.6em;
        font-weight: bold;
        margin-top: 8vh;
        margin-bottom: 2em;
        page-break-after: avoid;
    }
    h2.chapter-title span.chapter-name {
        display: block;
        font-size: 0.75em;
        font-weight: normal;
        color: #444;
        margin-top: 0.8em;
    }
    .chapter-content p {
        text-align: justify;
        text-indent: 1.5em;
        margin-top: 0;
        margin-bottom: 0.4em;
    }
    .image-page-wrapper {
        page-break-before: always;
        page-break-after: always;
        text-align: center;
        margin: 0;
        padding: 0;
    }
    .image-page-wrapper img {
        max-width: 100%;
        max-height: 95vh;
        height: auto;
        display: inline-block;
        margin: 0 auto;
    }
    """
    nav_css = epub.EpubItem(uid="style_nav", file_name="style/nav.css", media_type="text/css", content=css_content)
    book.add_item(nav_css)

    # 2. CREATE COVER / TITLE PAGE
    title_page = epub.EpubHtml(title='Title Page', file_name='title_page.xhtml', lang='ru')
    title_page.content = f"""
        <div class="title-page">
            <h1>{book_title}</h1>
            <h3>Том: {selected_chapters.volume}</h3>
            <h3>Translated by: {pref_team_name}</h3>
            <h3>Downloaded from the ranobelib.me using <a href="https://github.com/neoslvt/ranobelib-epub">ranobelib-epub by Neoslvt</a></h3>
        </div>
    """
    title_page.add_item(nav_css)
    book.add_item(title_page)

    epub_chapters = []
    img_counter = [1]
    downloaded_count = 0

    print(f"\nProcessing {len(selected_chapters)} chapters...\n")

    # 3. PROCESS CHAPTERS
    for ch in selected_chapters:
        vol = ch.get("volume")
        num = ch.get("number")
        name = ch.get("name") or ""
        ch_branches = ch.get("branches", [])
        
        if not ch_branches: continue

        target_branch = next((b for b in ch_branches if b.get("branch_id") == pref_branch_id), None)
        if not target_branch:
            target_branch = ch_branches[0]
            print(f"  [Info] Preferred translation missing for Ch {num}, falling back to alternative.")

        branch_id = target_branch.get("branch_id")
        print(f"Fetching Vol {vol} Ch {num}...", end=" ", flush=True)
        
        content_data = fetch_chapter_content(slug, vol, num, branch_id)
        if not content_data or not content_data.get("content"):
            print("NO CONTENT, skipping.")
            continue

        raw_html = content_data.get("content", "")
        processed_html = process_images(raw_html, book, img_counter)

        # Build beautifully structured HTML
        html_structure = f"""
        <h2 class="chapter-title">
            Глава {num}
            {f'<span class="chapter-name">{name}</span>' if name else ''}
        </h2>
        <div class="chapter-content">
            {processed_html}
        </div>
        """

        file_name = f"vol{vol}_ch{str(num).replace('.', '_')}.xhtml"
        chapter_item = epub.EpubHtml(
            title=f"Том {vol} Глава {num}: {name}",
            file_name=file_name,
            lang='ru'
        )
        chapter_item.content = html_structure
        chapter_item.add_item(nav_css)

        book.add_item(chapter_item)
        epub_chapters.append(chapter_item)
        downloaded_count += 1
        print("OK")

        time.sleep(0.6)

    if downloaded_count == 0:
        print("\n[!] No chapter contents could be retrieved.")
        return

    # 4. FINALIZE BOOK
    book.toc = tuple(epub_chapters)
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())

    # Ensure Title page is first in reading order
    book.spine = [title_page, 'nav'] + epub_chapters

    epub.write_epub(output_filename, book, {})
    print(f"\nSuccess! Downloaded {downloaded_count} chapters.")
    print(f"Saved Styled EPUB to: {os.path.abspath(output_filename)}")


if __name__ == "__main__":
    main()