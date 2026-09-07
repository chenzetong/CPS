cask "cockpit-tools" do
  version "1.3.43"
  sha256 "8c5ed80f225b651e3947a11ba8f9c819f65ec16b3bcebfc93ee1c88ebb29a547"

  url "https://github.com/chenzetong/CPS/releases/download/v#{version}/CPS_#{version}_universal.dmg"
  name "CPS"
  desc "Cockpit Tools fork with SSH Codex history synchronization"
  homepage "https://github.com/chenzetong/CPS"

  auto_updates true

  app "CPS.app"

  postflight_steps do
    run "/usr/bin/xattr",
        args: ["-cr", "{{appdir}}/CPS.app"],
        sudo: true
  end

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
