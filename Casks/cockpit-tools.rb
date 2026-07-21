cask "cockpit-tools" do
  version "1.3.10"
  sha256 "f910ad875820993152f381ae02c18335b36bf35122e2af23b72a2b596f209974"

  url "https://github.com/chenzetong/CPS/releases/download/v#{version}/CPS_#{version}_universal.dmg",
      verified: "github.com/chenzetong/CPS/"
  name "CPS"
  desc "Cockpit Tools fork with SSH Codex history synchronization"
  homepage "https://github.com/chenzetong/CPS"

  auto_updates true

  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-cr", "#{appdir}/CPS.app"],
                   sudo: true
  end

  app "CPS.app"

  zap trash: [
    "~/Library/Application Support/com.chenzetong.cps",
    "~/Library/Caches/com.chenzetong.cps",
    "~/Library/Preferences/com.chenzetong.cps.plist",
    "~/Library/Saved Application State/com.chenzetong.cps.savedState",
  ]

  caveats <<~EOS
    The app is automatically quarantined by macOS. A postflight hook has been added to remove this quarantine.
    If you still encounter the "App is damaged" error, please run:
      sudo xattr -rd com.apple.quarantine "/Applications/CPS.app"
  EOS
end
